import { supabase } from '../../../lib/supabase';
import { readAllBySite } from '../../omnivore/sync/inventory/supabase-read';
import { logger } from '../../../lib/logger';
import { convertCloverOrderToMCMOrder } from './order-mapper';
import { mergeCloverManagedLineItems, cloverIdsOf } from './managed-merge';

interface UpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
  maxModifiedTime: number;
}

/**
 * GUARD anti-doble-cobro (idéntico a omnivore/sync/upsert-orders.ts). `true` si la
 * orden YA tiene un pago aplicado en MCM (al menos un `payments` con
 * status='completed'). El sync NO debe reabrir/des-pagar una orden pagada: si la
 * inyección del pago a Clover falló, Clover la reporta abierta (paymentState != PAID)
 * y, sin guard, el sync la pisa a new-order/not_fulfilled/paid=0 → re-pagable.
 * Fuente de verdad = tabla `payments` (orders.payment_status/paid no son confiables:
 * el propio sync los sobrescribe). Multi-tenant: scoped por site_id.
 */
async function orderHasAppliedPayment(siteId: number, orderId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from('payments')
    .select('id')
    .eq('site_id', siteId)
    .contains('orders_ids', [orderId])
    .eq('status', 'completed')
    .limit(1)
    .maybeSingle();

  if (error) {
    // Fail-safe: ante error de lookup nunca arriesgar un re-cobro → tratar la
    // orden como pagada (preservar campos de pago). Se reintenta al próximo ciclo.
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover guard: payment lookup failed — preserving payment fields');
    return true;
  }
  return !!data;
}

function verifyOrderHasRelevantChanges(order1: any, order2: any): boolean {
  if (!order1 || !order2) return true;

  const normalizeNumber = (v: any) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    return isNaN(n) ? v : n;
  };

  const deepEqual = (x: any, y: any) => JSON.stringify(x) === JSON.stringify(y);

  const normalizeArray = (arr: any, keyFields: string[] = []) => {
    if (!Array.isArray(arr)) return [];
    return [...arr]
      .map((x) => ({
        ...x,
        price: normalizeNumber(x.price),
        total: normalizeNumber(x.total),
        subtotal: normalizeNumber(x.subtotal),
        tax_total: normalizeNumber(x.tax_total),
        total_tax: normalizeNumber(x.total_tax),
        quantity: normalizeNumber(x.quantity),
      }))
      .sort((a: any, b: any) => {
        for (const key of keyFields) {
          if (a[key] < b[key]) return -1;
          if (a[key] > b[key]) return 1;
        }
        return 0;
      });
  };

  const numericFields = ['subtotal', 'discount_total', 'shipping_total', 'fee_total', 'total_tax', 'total', 'paid'];
  for (const f of numericFields) {
    if (normalizeNumber(order1[f]) !== normalizeNumber(order2[f])) return true;
  }

  const directFields = ['order_type', 'payment_status'];
  for (const f of directFields) {
    if (!deepEqual(order1[f], order2[f])) return true;
  }

  const ticketName1 = String(order1?.customer?.first_name ?? '').trim();
  const ticketName2 = String(order2?.customer?.first_name ?? '').trim();
  if (ticketName1 !== ticketName2) return true;

  const s1 = order1.status;
  const s2 = order2.status;
  if (s1 === 'check-closed' && s2 !== 'check-closed') return true;
  if (s1 === 'new-order' && s2 === 'check-closed') return true;

  const structFields = ['employee', 'table'];
  for (const f of structFields) {
    if (!deepEqual(order1[f], order2[f])) return true;
  }

  const lineItems1 = normalizeArray(order1.line_items, ['id', 'product_id']);
  const lineItems2 = normalizeArray(order2.line_items, ['id', 'product_id']);
  if (!deepEqual(lineItems1, lineItems2)) return true;

  const taxLines1 = normalizeArray(order1.tax_lines, ['id', 'rate_code']);
  const taxLines2 = normalizeArray(order2.tax_lines, ['id', 'rate_code']);
  if (!deepEqual(taxLines1, taxLines2)) return true;

  return false;
}

export async function upsertOrdersFromClover(
  siteId: number,
  cloverOrders: unknown[],
  opts?: { tableServiceEnabled?: boolean; fetchStartIso?: string }
): Promise<UpsertResult> {
  const tableServiceEnabled = opts?.tableServiceEnabled === true;
  const fetchStartIso = opts?.fetchStartIso;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let maxModifiedTime = 0;

  // Build cloverItemId → MCM product id once so pulled line items resolve to synced products
  // (enables edit/repeat/86 in the POS). Best-effort; absent map → line items keep the Clover id.
  const productMap = new Map<string, number>();
  {
    // Paginado: sin esto, en un catálogo de >1000 productos las líneas de las órdenes de los
    // productos 1001+ se quedan con el id de Clover en vez del `product_id` de MCM.
    const prodRows = await readAllBySite<any>('products', siteId, 'id, additional_properties');
    for (const p of prodRows ?? []) {
      const apRaw = (p as any).additional_properties;
      const ap = typeof apRaw === 'string' ? (() => { try { return JSON.parse(apRaw); } catch { return {}; } })() : (apRaw || {});
      if (ap.cloverId) productMap.set(String(ap.cloverId), Number((p as any).id));
    }
  }

  for (const raw of cloverOrders) {
    const cloverOrder = raw as any;

    if (cloverOrder.modifiedTime && cloverOrder.modifiedTime > maxModifiedTime) {
      maxModifiedTime = cloverOrder.modifiedTime;
    }

    // Una orden marcada `Deleted` en Clover NO desaparece del pull: se sigue devolviendo
    // con sus líneas (medido contra el merchant sandbox — Clover ni valida ni aplica el
    // `state`). Sin este filtro se importa como ticket VIVO `new-order`. Medido: 5 órdenes
    // `Deleted` entraron como 5 tickets abiertos en el banco de pruebas.
    if (String(cloverOrder.state ?? '').toLowerCase() === 'deleted') {
      skipped++;
      continue;
    }

    const order = convertCloverOrderToMCMOrder(cloverOrder, productMap);
    const cloverPosId = order.clover_pos_id as string;
    // WS-12/F30: id de Clover alfanumérico; saltar uno malformado evita romper el `.or()`.
    if (!cloverPosId || !/^[A-Za-z0-9_-]+$/.test(cloverPosId)) {
      logger.warn({ site_id: siteId, clover_pos_id: cloverPosId }, 'clover upsert: skipping order with malformed clover id');
      skipped++;
      continue;
    }
    const expectedGlobalPosId = `${siteId}-${cloverPosId}`;

    // WS-6/F12 (auditoría 2026-06-09): buscar también por `clover_ticket_id`. Una
    // orden nacida en Omnivore y empujada a Clover tiene `clover_ticket_id` poblado
    // pero `clover_pos_id=NULL`; sin esto el pull no la encontraba e INSERTABA un
    // duplicado huérfano. Se prefiere la fila canónica (con `omnivore_pos_id`) ante
    // un empate, y el update unifica la identidad seteando `clover_pos_id`.
    const { data: byCloverPosId, error: byCloverPosIdError } = await supabase
      .from('orders')
      .select('*')
      .eq('site_id', siteId)
      .or(`clover_pos_id.eq.${cloverPosId},clover_ticket_id.eq.${cloverPosId}`)
      .order('omnivore_pos_id', { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (byCloverPosIdError) {
      logger.error(
        { error: byCloverPosIdError, site_id: siteId, clover_pos_id: cloverPosId },
        'clover upsert: skipping order — clover_pos_id lookup failed'
      );
      skipped++;
      continue;
    }

    const existing = byCloverPosId;

    if (existing) {
      order.id = existing.id;
      order.site_id = existing.site_id;

      // A1 — PRESERVAR `additional_properties`. El mapper emite `{}` a nivel de orden
      // (order-mapper.ts) y el UPDATE de abajo escribe `order` entero, así que sin esto
      // cada ciclo borra TODO lo que viva ahí:
      //   · `clover_supplemental` — el manifiesto que escribe `claim_clover_supplement`
      //     y lo único que permite al pago de una orden suplementaria encontrar a su
      //     orden padre (upsert-payments.ts) y, con ella, reenviarse a Omnivore.
      //   · `omnivore_managed` / `omnivore_synced_at` — en un site con las dos.
      // Se funde lo existente DEBAJO de lo que traiga el mapper, para que si algún día
      // el pull emite claves propias, esas ganen.
      {
        const apRaw = (existing as any).additional_properties;
        const apPrev =
          typeof apRaw === 'string'
            ? (() => { try { return JSON.parse(apRaw); } catch { return {}; } })()
            : (apRaw || {});
        (order as any).additional_properties = {
          ...apPrev,
          ...((order as any).additional_properties || {}),
        };
      }

      // GUARD anti-doble-cobro robusto (reemplaza el guard débil previo que confiaba
      // en orders.payment_status + total-unchanged). Si la orden ya tiene un pago
      // aplicado en MCM, preservamos sus campos de pago; line items y totales sí
      // pueden seguir sincronizando.
      if (await orderHasAppliedPayment(existing.site_id, existing.id)) {
        order.status = existing.status;
        order.payment_status = existing.payment_status;
        order.paid = existing.paid;
      }

      // ── MODO GESTIONADO (espejo de omnivore/sync/upsert-orders.ts) ──────────────
      // Con los dos lados escribiendo sobre la misma mesa abierta, el overwrite de abajo
      // borraría lo que el mesero acaba de añadir en /pos-order. Aquí se hace merge por
      // línea. Un site SIN `cloverTableServiceEnabled` no entra aquí jamás y se comporta
      // exactamente igual que antes.
      const isManaged =
        (existing as any).additional_properties?.clover_managed === true ||
        (tableServiceEnabled && String((existing as any).channel ?? '').toLowerCase() === 'pos');

      if (isManaged) {
        // Freshness guard: si un push salió DESPUÉS del snapshot de este pull, su estado
        // es más nuevo → saltar. El próximo ciclo toma la orden fresca.
        const syncedAt = (existing as any).additional_properties?.clover_synced_at as string | undefined;
        if (fetchStartIso && syncedAt && syncedAt > fetchStartIso) { skipped++; continue; }

        const mergedLineItems = mergeCloverManagedLineItems(
          (existing as any).line_items,
          (order as any).line_items
        );

        // ¿Hay líneas que sólo existen en MCM (añadidas y aún no empujadas)?
        // Si las hay, MCM va por delante: sus totales ya las incluyen y los de Clover no.
        // Tomar los de Clover subvaloraría la cuenta. Se conservan los de MCM hasta que
        // el push las suba y el pull siguiente alinee.
        const hayLocalesSinEmpujar = mergedLineItems.some(
          (li: any) => li.status !== 'voided' && cloverIdsOf(li).length === 0
        );

        const updatePayload: Record<string, unknown> = {
          line_items: mergedLineItems,
          additional_properties: {
            ...((existing as any).additional_properties ?? {}),
            clover_managed: true,
            clover_synced_at: new Date().toISOString(),
          },
        };
        if (!hayLocalesSinEmpujar) {
          updatePayload.subtotal = (order as any).subtotal;
          updatePayload.total = (order as any).total;
          updatePayload.total_tax = (order as any).total_tax;
          updatePayload.discount_total = (order as any).discount_total;
          updatePayload.tax_lines = (order as any).tax_lines;
        }
        // Los campos de pago los gobierna el guard anti-doble-cobro de arriba.
        updatePayload.status = (order as any).status;
        updatePayload.payment_status = (order as any).payment_status;
        updatePayload.paid = (order as any).paid;

        // Anti-churn: no escribir si nada cambió de verdad (evita despertar el realtime
        // del mesero cada 60 s y disparar su banner de conflicto sin motivo).
        const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const numEq = (a: unknown, b: unknown) => Number(a ?? 0) === Number(b ?? 0);
        const sinCambios =
          jsonEq(mergedLineItems, (existing as any).line_items) &&
          numEq(updatePayload.total ?? (existing as any).total, (existing as any).total) &&
          numEq(updatePayload.paid ?? (existing as any).paid, (existing as any).paid) &&
          (updatePayload.status ?? (existing as any).status) === (existing as any).status &&
          (updatePayload.payment_status ?? (existing as any).payment_status) === (existing as any).payment_status;
        if (sinCambios) { skipped++; continue; }

        // CAS sobre date_updated: si el mesero escribió desde el snapshot, no se pisa.
        const { data: casRows, error: casErr } = await supabase
          .from('orders')
          .update(updatePayload)
          .eq('id', existing.id)
          .eq('site_id', existing.site_id)
          .eq('date_updated', (existing as any).date_updated)
          .select('id');

        if (casErr) {
          logger.error({ error: casErr, site_id: siteId, clover_pos_id: cloverPosId }, 'clover merge: update failed');
          skipped++;
        } else if (!casRows || casRows.length === 0) {
          skipped++;   // conflicto CAS → se reintegra en el próximo ciclo
        } else {
          updated++;
        }
        continue;
      }

      if (
        existing?.channel?.toLowerCase() === 'pos' &&
        verifyOrderHasRelevantChanges(existing, order)
      ) {
        const { error: updateError } = await supabase
          .from('orders')
          .update(order)
          .eq('id', existing.id)
          .eq('site_id', existing.site_id);

        if (updateError) {
          logger.error({ error: updateError, site_id: siteId, clover_pos_id: cloverPosId }, 'clover upsert: update failed');
          skipped++;
        } else {
          updated++;
        }
      }
    } else {
      const randomNumberId = Math.floor(Math.random() * 10_000_000_000_000_000);
      order.site_id = siteId;
      order.id = randomNumberId;

      // Una orden NACIDA en Clover llega sin sello. Sin él `/pos-order` no la reconoce como
      // gestionada —las funciones edge exigen `clover_managed === true`— y firear un ítem
      // nuevo NO llegaría al terminal. El merge del pull siguiente sí lo pondría, pero el
      // hueco cae justo en el primer servicio de la mesa, que es cuando se usa.
      if (tableServiceEnabled && String((order as any).channel ?? '').toLowerCase() === 'pos') {
        (order as any).additional_properties = {
          ...((order as any).additional_properties ?? {}),
          clover_managed: true,
          clover_synced_at: new Date().toISOString(),
        };
      }

      const { error: upsertError } = await supabase
        .from('orders')
        .upsert(
          { ...order, global_pos_id: expectedGlobalPosId },
          { onConflict: 'site_id,clover_pos_id', ignoreDuplicates: true }
        );

      if (upsertError) {
        logger.error({ error: upsertError, site_id: siteId, clover_pos_id: cloverPosId }, 'clover upsert: insert failed');
        skipped++;
      } else {
        inserted++;
      }
    }
  }

  return { inserted, updated, skipped, maxModifiedTime };
}
