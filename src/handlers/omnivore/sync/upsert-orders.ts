import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { convertOmnivoreOrderToMCMOrder } from './order-mapper';
import { mergeManagedOrderLineItems } from './merge-managed-order';

interface UpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * GUARD anti-doble-cobro. `true` si la orden YA tiene un pago aplicado en MCM
 * (al menos un `payments` con status='completed'). El sync de Omnivore NO debe
 * reabrir ni des-pagar una orden pagada: si la inyección del pago a Omnivore
 * falló, Omnivore la reporta abierta (due>0, paid=0) y, sin este guard, el sync
 * la pisa a new-order/not_fulfilled/paid=0 → queda re-pagable (doble cobro).
 *
 * Fuente de verdad = tabla `payments` (orders.payment_status/paid no son
 * confiables: el propio sync los sobrescribe). Multi-tenant: scoped por site_id.
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
    logger.error({ error, site_id: siteId, order_id: orderId }, 'omnivore guard: payment lookup failed — preserving payment fields');
    return true;
  }
  return !!data;
}

/**
 * check_numbers de los cheques ABIERTOS de una mesa — el dominio EXACTO del índice único
 * `orders_unique_check_number_per_open_table (table_id, check_number) WHERE closed_at IS
 * NULL AND table_id IS NOT NULL`. El sync insertaba sin check_number (default 1), así que
 * TODO 2º cheque abierto de la misma mesa violaba el índice en cada ciclo y nunca aparecía
 * en MCM mientras estuviera abierto (Arena Medalla mesa 21, 2026-07-14). Fail-open: ante
 * error de lookup devuelve null y el caller conserva el default (nunca peor que antes).
 */
async function openCheckNumbersForTable(
  siteId: number,
  tableId: string,
  excludeOrderId?: number,
): Promise<number[] | null> {
  let query = supabase
    .from('orders')
    .select('check_number')
    .eq('site_id', siteId)
    .eq('table_id', tableId)
    .is('closed_at', null);
  if (excludeOrderId != null) query = query.neq('id', excludeOrderId);
  const { data, error } = await query;
  if (error) {
    logger.error({ error, site_id: siteId, table_id: tableId }, 'omnivore sync: check_number lookup failed — keeping default');
    return null;
  }
  return (data ?? []).map((r: any) => Number(r.check_number ?? 1));
}

const nextCheckNumber = (siblings: number[]): number =>
  siblings.reduce((max, n) => Math.max(max, n), 0) + 1;

/**
 * WS-8/F15 (auditoría 2026-06-09): atribución de dinero cuando la orden se cobra
 * DIRECTO en Omnivore (due==0) y NO existe un pago en MCM. Sin esto la orden queda
 * `check-closed`/`fulfilled` pero el dinero es invisible para el dashboard de pagos /
 * settlement. Crea una fila `payments` de "pago externo POS". Idempotente: si ya hay
 * un pago aplicado (MCM o externo) no duplica.
 */
async function recordExternalOmnivorePaymentIfNeeded(siteId: number, orderId: number, order: any): Promise<void> {
  if (order.payment_status !== 'fulfilled') return;
  const paid = Number(order.paid ?? 0);
  if (!(paid > 0)) return;
  if (await orderHasAppliedPayment(siteId, orderId)) return; // ya hay pago → no duplicar
  const now = new Date().toISOString();
  const { error } = await supabase.from('payments').insert({
    site_id: siteId,
    orders_ids: [orderId],
    method: 'ecr-card',
    status: 'completed',
    total: paid.toFixed(2),
    tip: '0.00',
    source: 'Omnivore POS',
    reference: `omnivore:${order.pos_id}`,
    employee: {},
    additional_properties: { external_pos_payment: true, origin: 'omnivore-sync' },
    date_created: now,
    date_updated: now,
  });
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'omnivore sync: external payment record failed');
  }
}

/**
 * Ported verbatim from omnivore-helper.ts:verifyOrderHasRelevantChanges. Avoids
 * needless writes when the synced order is materially unchanged.
 */
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

/**
 * Upserts Omnivore tickets into MCM `orders`, deduped on
 * (site_id, omnivore_pos_id). Mirrors the legacy `syncOmnivoreOrdersIntoMCM`:
 * existing POS orders are updated only when materially changed; new orders are
 * inserted with `omnivore_pos_id` + `global_pos_id`. Non-POS orders are never
 * overwritten by the sync.
 */
export async function upsertOmnivoreOrders(
  siteId: number,
  omnivoreOrders: unknown[],
  config: any,
  fetchStartIso?: string | null,
): Promise<UpsertResult> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // Mapa omnivoreId → product_id (MCM) para resolver los ítems POS-originados al
  // product real (evita el throw del OrderCalculator y deja editar órdenes mixtas).
  const omnivoreIdToProductId = new Map<string, number>();
  {
    const { data: prods } = await supabase
      .from('products')
      .select('id, additional_properties')
      .eq('site_id', siteId);
    for (const p of prods ?? []) {
      const oid = (p as any)?.additional_properties?.omnivoreId;
      if (oid != null) omnivoreIdToProductId.set(String(oid), Number((p as any).id));
    }
  }

  // Mapa external_id (id de mesa del POS) → floor_element MCM. Linkea las órdenes sincronizadas
  // al floor (table_id + table.id = UUID del floor_element) para que sean consistentes con las
  // creadas por MCM → /details (2º cheque), agrupación de cheques y transfer funcionan sin
  // depender del fallback. No-op si la mesa no está importada al floor (mapa sin esa entrada).
  const tableFloorByExternalId = new Map<string, { id: string; label: string; revenue_center_id: string }>();
  {
    const { data: tables } = await supabase
      .from('floor_elements')
      .select('id, external_id, table_name, table_number, revenue_center_id')
      .eq('site_id', siteId)
      .eq('type', 'table');
    for (const fe of tables ?? []) {
      if ((fe as any).external_id == null) continue;
      const ext = String((fe as any).external_id);
      // Si hubiera duplicados (planes archivados), conservamos el primero de forma determinística.
      if (!tableFloorByExternalId.has(ext)) {
        tableFloorByExternalId.set(ext, {
          id: String((fe as any).id),
          label: (fe as any).table_name ?? (fe as any).table_number ?? ext,
          revenue_center_id: (fe as any).revenue_center_id ?? '',
        });
      }
    }
  }

  const tableServiceEnabled = (config as any)?.omnivoreTableServiceEnabled === true;

  for (const raw of omnivoreOrders) {
    // Per-order guard: a single malformed ticket must not fail the whole batch.
    let omnivorePosId = '(unknown)';
    try {
      const order = convertOmnivoreOrderToMCMOrder(raw as any, config, omnivoreIdToProductId);
      omnivorePosId = order.pos_id as string;

      // Linkeo al floor_element MCM por external_id (= id de mesa de Omnivore). Deja table_id +
      // table.id con el UUID del floor_element (consistente con órdenes MCM-creadas). El objeto
      // `order` ya corregido cubre el INSERT y el path no-managed (que escribe `order` completo);
      // para el path managed se aplica explícitamente más abajo. No-op si la mesa no está en el floor.
      const floorEl = (order as any)?.table?.id
        ? tableFloorByExternalId.get(String((order as any).table.id))
        : undefined;
      if (floorEl) {
        (order as any).table_id = floorEl.id;
        (order as any).table = {
          ...((order as any).table ?? {}),
          id: floorEl.id,
          label: (order as any).table?.label || floorEl.label,
          revenue_center_id: (order as any).table?.revenue_center_id || floorEl.revenue_center_id,
        };
      }

      const { data: existing, error: lookupError } = await supabase
        .from('orders')
        .select('*')
        .eq('site_id', siteId)
        .eq('omnivore_pos_id', omnivorePosId)
        .limit(1)
        .maybeSingle();

      if (lookupError) {
        logger.error(
          { error: lookupError, site_id: siteId, omnivore_pos_id: omnivorePosId },
          'omnivore upsert: lookup failed — skipping order'
        );
        skipped++;
        continue;
      }

      if (existing) {
        order.id = existing.id;
        order.site_id = existing.site_id;

        // GUARD anti-doble-cobro: si la orden ya tiene un pago aplicado en MCM,
        // preservamos sus campos de pago para que el sync NUNCA la reabra/des-pague.
        if (await orderHasAppliedPayment(existing.site_id, existing.id)) {
          order.status = existing.status;
          order.payment_status = existing.payment_status;
          order.paid = existing.paid;
        }

        // Una orden usa el MERGE no-destructivo si tiene el flag `omnivore_managed`, O si es una
        // orden de table-service editable en O&P (dine-in `qe` / `tab`) en un site con table-service.
        // Esto último es defensa de fondo: aunque a la orden le falte el flag (insertada por código/
        // binario viejo, o sin backfill), NUNCA cae al overwrite destructivo que borra estado
        // local-only (ítems sin enviar + asiento). No depende de que el flag esté persistido: se
        // reevalúa en cada pull. Los sites SIN table-service quedan idénticos a hoy.
        const isManaged =
          (existing as any).additional_properties?.omnivore_managed === true ||
          (tableServiceEnabled &&
            (existing as any).channel?.toLowerCase() === 'pos' &&
            ((existing as any).experience === 'qe' || (existing as any).experience === 'tab'));

        if (isManaged) {
          // ── MERGE bidireccional a nivel de ítem (no overwrite). Totales desde Omnivore. ──
          // Freshness guard: si un fire/void/open outbound ocurrió DESPUÉS del snapshot de
          // este pull, su sync es más nuevo → saltamos (no regresar total ni anular un ítem
          // recién fireado). El próximo ciclo (60s) toma el ticket fresco.
          const syncedAt = (existing as any).additional_properties?.omnivore_synced_at as string | undefined;
          if (fetchStartIso && syncedAt && syncedAt > fetchStartIso) {
            skipped++;
            continue;
          }

          const mergedLineItems = mergeManagedOrderLineItems(
            (existing as any).line_items,
            (order as any).line_items,
          );
          const mergedAp = {
            ...((existing as any).additional_properties ?? {}),
            omnivore_managed: true,
            omnivore_synced_at: new Date().toISOString(),
          };

          // Totales: Omnivore es autoritativo SOLO cuando el ticket ya tiene ítems fireados.
          // Si el ticket está vacío (todos los ítems siguen sin firear en MCM), no hay nada
          // que Omnivore "mande" → MCM conserva su total calculado CON tax (no pisar a 0).
          // Una vez hay ítems en Omnivore: total = Omnivore (fireado, incl. su tax) + preview
          // de los no-firados (su subtotal), idéntico a send-to-kitchen/void-line-item.
          const omnivoreFiredItems = Array.isArray((order as any).line_items)
            ? (order as any).line_items
            : [];
          const omnivoreHasItems = omnivoreFiredItems.length > 0;
          // FIX doble conteo (2026-07-10): `order.total` de Omnivore YA incluye TODOS los ítems del
          // ticket (fireados Y no-fireados — Omnivore cuenta todo lo que está en el ticket). Por eso
          // los no-fireados que YA están en el ticket (tienen su omnivore.item_id en
          // `order.line_items`) NO deben re-sumarse en `unfiredPreview`: si no, se cuentan dos veces
          // → total al doble (verificado en vivo, orden managed con ítems rung-en-terminal sin firear).
          // Solo se suman al preview los no-fireados que NO están en el ticket (ítems agregados en
          // O&P, aún no enviados a Omnivore) — para que el total no fluctúe antes de firear.
          const omnivoreTicketItemIds = new Set<string>();
          for (const m of omnivoreFiredItems) {
            const o = (m as any)?.additional_properties?.omnivore;
            if (o?.item_id != null) omnivoreTicketItemIds.add(String(o.item_id));
            if (Array.isArray(o?.item_ids)) for (const x of o.item_ids) if (x != null) omnivoreTicketItemIds.add(String(x));
          }
          const lineOmniIds = (li: any): string[] => {
            const o = li?.additional_properties?.omnivore;
            if (!o) return [];
            const ids: string[] = [];
            if (Array.isArray(o.item_ids)) for (const x of o.item_ids) if (x != null) ids.push(String(x));
            if (o.item_id != null) { const s = String(o.item_id); if (!ids.includes(s)) ids.push(s); }
            return ids;
          };
          const unfiredItems = (mergedLineItems as any[])
            .filter(
              (li) =>
                li.status !== 'sent' &&
                li.status !== 'voided' &&
                !lineOmniIds(li).some((id) => omnivoreTicketItemIds.has(id)),
            );
          const unfiredPreview = unfiredItems.reduce((sum, li) => sum + Number(li.total ?? 0), 0);
          // F3 (fluctuación de total): incluir el tax de los ítems NO-firados en el total
          // mostrado. Sin esto el total bajaba/subía entre add-products-to-order (que calcula
          // CON tax) y el sync (que lo dejaba sin tax). Ahora el merge muestra
          // total = Omnivore(fireado, incl. su tax) + preview no-firado (subtotal + su tax).
          const unfiredTaxPreview = unfiredItems.reduce((sum, li) => sum + Number(li.total_tax ?? 0), 0);

          // status/payment: mientras el ticket siga ABIERTO en el POS, el ciclo de vida lo
          // maneja MCM (el motor O&P) → preservamos lo existente (no regresar a new-order ni
          // forzar check-closed). Solo cuando Omnivore reporta el check CERRADO/PAGADO
          // (payment_status='fulfilled') adoptamos el cierre.
          const posClosed = order.payment_status === 'fulfilled';

          const totalsPayload: Record<string, unknown> = omnivoreHasItems
            ? {
                subtotal: Number(order.subtotal) + unfiredPreview,
                total: Number(order.total) + unfiredPreview + unfiredTaxPreview,
                total_tax: Number(order.total_tax) + unfiredTaxPreview,
                tax_lines: order.tax_lines,
                fee_lines: order.fee_lines,
                fee_total: order.fee_total,
                discount_total: order.discount_total,
              }
            : {
                subtotal: existing.subtotal,
                total: existing.total,
                total_tax: existing.total_tax,
                tax_lines: existing.tax_lines,
                fee_lines: existing.fee_lines,
                fee_total: existing.fee_total,
                discount_total: existing.discount_total,
              };

          // Linkeo de floor (cura órdenes sincronizadas): si la mesa resolvió a un floor_element
          // y la orden aún no lo tiene en table_id / table.id, lo seteamos. `order.table` ya viene
          // corregido arriba. Solo agregamos las claves que difieren (para no forzar churn ni
          // tocar órdenes ya linkeadas / sin floor_element).
          const floorPatch: Record<string, unknown> = {};
          if (floorEl) {
            if (String((existing as any).table_id ?? '') !== floorEl.id) {
              floorPatch.table_id = floorEl.id;
              // Al re-linkear table_id la fila ENTRA al índice único de cheques abiertos:
              // si un hermano abierto ya usa su check_number, el UPDATE fallaría con 23505
              // en cada ciclo → asignar el siguiente libre solo en ese caso.
              if (!(existing as any).closed_at) {
                const siblings = await openCheckNumbersForTable(siteId, floorEl.id, Number(existing.id));
                if (siblings && siblings.includes(Number((existing as any).check_number ?? 1))) {
                  floorPatch.check_number = nextCheckNumber(siblings);
                }
              }
            }
            if (String((existing as any).table?.id ?? '') !== floorEl.id) floorPatch.table = (order as any).table;
          }

          const updatePayload: Record<string, unknown> = {
            line_items: mergedLineItems,
            ...totalsPayload,
            ...floorPatch,
            paid: posClosed ? order.paid : existing.paid,
            payment_status: posClosed ? order.payment_status : existing.payment_status,
            status: posClosed ? order.status : existing.status,
            additional_properties: mergedAp,
            date_updated: new Date().toISOString(),
          };

          // F4 (anti-churn ROBUSTO): saltar el UPDATE solo si NADA material cambió. Comparamos
          // el contenido COMPLETO de line_items (no solo el total → detecta un cambio de ítem
          // con el mismo monto: nombre, qty, modifier, status, oid, etc.) + todos los totales +
          // paid/payment_status/status. Excluye date_updated y omnivore_synced_at (bookkeeping).
          // Ante CUALQUIER diferencia, escribimos (sesga a actualizar = seguro).
          // Comparar a nivel de CENTAVOS: el DB guarda los totales redondeados (2 dec) y el
          // recomputado es float full-precision → un `===` crudo nunca coincide (churn perpetuo).
          const numEq = (a: unknown, b: unknown) =>
            Math.round(Number(a ?? 0) * 100) === Math.round(Number(b ?? 0) * 100);
          const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
          const unchanged =
            jsonEq(mergedLineItems, (existing as any).line_items) &&
            numEq(updatePayload.subtotal, existing.subtotal) &&
            numEq(updatePayload.total, existing.total) &&
            numEq(updatePayload.total_tax, existing.total_tax) &&
            numEq(updatePayload.fee_total, existing.fee_total) &&
            numEq(updatePayload.discount_total, existing.discount_total) &&
            numEq(updatePayload.paid, (existing as any).paid) &&
            updatePayload.payment_status === existing.payment_status &&
            updatePayload.status === existing.status &&
            jsonEq(updatePayload.tax_lines, (existing as any).tax_lines) &&
            jsonEq(updatePayload.fee_lines, (existing as any).fee_lines) &&
            Object.keys(floorPatch).length === 0;
          if (unchanged) { skipped++; continue; }

          // CAS en date_updated: si el mesero editó desde el snapshot, no pisamos.
          const { data: casRows, error: updErr } = await supabase
            .from('orders')
            .update(updatePayload)
            .eq('id', existing.id)
            .eq('site_id', existing.site_id)
            .eq('date_updated', (existing as any).date_updated)
            .select('id');

          if (updErr) {
            logger.error({ error: updErr, site_id: siteId, omnivore_pos_id: omnivorePosId }, 'omnivore merge: update failed');
            skipped++;
          } else if (!casRows || casRows.length === 0) {
            // Conflicto CAS (el mesero escribió): se reintegra en el próximo ciclo.
            skipped++;
          } else {
            updated++;
            await recordExternalOmnivorePaymentIfNeeded(siteId, existing.id, order);
          }
          continue;
        }

        // ── No-managed (POS pura / sin table-service / pickup): Omnivore autoritativo de
        // totales/estado, COMO HOY. Defensa en profundidad SOLO en sites con table-service:
        // merge de line_items por `omnivore.item_id` para NUNCA destruir estado local-only
        // (unsent/seat) si una orden se coló sin el flag (p.ej. pickup, que no es qe/tab).
        // Los sites SIN table-service quedan IDÉNTICOS a hoy (cero cambio de comportamiento).
        if (existing?.channel?.toLowerCase() === 'pos') {
          if (tableServiceEnabled) {
            (order as any).line_items = mergeManagedOrderLineItems(
              (existing as any).line_items,
              (order as any).line_items,
            );
          }
          // Mismo guard de check_number que el path managed: este UPDATE escribe `order`
          // completo (incluye table_id cuando floorEl resolvió). Si RE-LINKEA la mesa,
          // la fila entra al índice único de cheques abiertos → asignar el siguiente
          // check_number libre si el actual colisiona. Si table_id no cambia, no se toca
          // nada (el mapper no emite check_number; el valor existente se preserva).
          if (
            floorEl &&
            !(existing as any).closed_at &&
            String((existing as any).table_id ?? '') !== floorEl.id
          ) {
            const siblings = await openCheckNumbersForTable(siteId, floorEl.id, Number(existing.id));
            if (siblings && siblings.includes(Number((existing as any).check_number ?? 1))) {
              (order as any).check_number = nextCheckNumber(siblings);
            }
          }
          // El mapper emite `additional_properties: {}` a nivel de orden (order-mapper.ts) y este
          // UPDATE escribe `order` entero, así que TODO lo que viva ahí se borra cada ciclo (20 s).
          // El manifiesto de suplementos de Clover NO es del sync: lo escribe
          // `claim_clover_supplement` y es lo único que le permite al pago de una orden suplemental
          // encontrar su orden padre (upsert-payments.ts:225-236) y, con ella, inyectarse a Omnivore
          // (:399-406). Sin esto el pago se pierde. El path managed ya lo preserva (:311-315); esto
          // es lo mismo para el path no-managed, acotado a esa clave (`omnivore_managed` y
          // `omnivore_synced_at` sí son del sync y se dejan como vienen).
          const supplementalManifest = (existing as any)?.additional_properties?.clover_supplemental;
          if (supplementalManifest !== undefined) {
            (order as any).additional_properties = {
              ...((order as any).additional_properties ?? {}),
              clover_supplemental: supplementalManifest,
            };
          }

          // Tras el merge, escribir solo si algo material cambió (evita churn: si el único "cambio"
          // era el ítem local que el merge ya preservó, el order resultante == existing → skip).
          if (verifyOrderHasRelevantChanges(existing, order)) {
            const { error: updateError } = await supabase
              .from('orders')
              .update(order)
              .eq('id', existing.id)
              .eq('site_id', existing.site_id);
            if (updateError) {
              logger.error({ error: updateError, site_id: siteId, omnivore_pos_id: omnivorePosId }, 'omnivore upsert: update failed');
              skipped++;
            } else {
              updated++;
              await recordExternalOmnivorePaymentIfNeeded(siteId, existing.id, order);
            }
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      } else {
        // ── Carrera create (inbound vs outbound) ────────────────────────────────
        // Si este ticket lo creó MCM (open-table-order/open-tab) pero su orden aún NO tiene
        // omnivore_pos_id (ventana entre crear el ticket y `patchManagedOrder`), ADOPTAR esa
        // orden en vez de insertar una 2ª (que chocaría con el UNIQUE y dejaría 2 órdenes).
        // Determinista y Aloha-safe (sin eq(name)): el nombre del ticket es `MCM {order.id}`
        // (dine-in) o el nombre del tab (experience_reference). El nombre viaja en
        // `order.customer.first_name` (lo setea convertOmnivoreOrderToMCMOrder).
        const ticketName = String((order as any)?.customer?.first_name ?? '').trim();
        const mcmIdMatch = ticketName.match(/^MCM\s+(\d+)$/);
        let linkCand: { id: number; additional_properties: any } | null = null;
        if (mcmIdMatch) {
          const { data } = await supabase
            .from('orders')
            .select('id, additional_properties')
            .eq('site_id', siteId)
            .eq('id', Number(mcmIdMatch[1]))
            .is('omnivore_pos_id', null)
            .is('closed_at', null)
            .maybeSingle();
          linkCand = (data as any) ?? null;
        } else if (tableServiceEnabled && ticketName) {
          // Tab: linkear por nombre de cuenta (sin mesa).
          const { data } = await supabase
            .from('orders')
            .select('id, additional_properties')
            .eq('site_id', siteId)
            .eq('experience', 'tab')
            .eq('experience_reference', ticketName)
            .is('table_id', null)
            .is('omnivore_pos_id', null)
            .is('closed_at', null)
            .order('date_created', { ascending: false })
            .limit(1)
            .maybeSingle();
          linkCand = (data as any) ?? null;
        }

        if (linkCand?.id != null) {
          const mergedAp = {
            ...((linkCand.additional_properties ?? {}) as Record<string, unknown>),
            omnivore_managed: true,
          };
          // CAS `is(omnivore_pos_id, null)`: solo linkear si SIGUE sin link (si el outbound
          // ganó la carrera y ya seteó pos_id, no pisamos — ya está bien linkeada).
          const { data: linked, error: linkErr } = await supabase
            .from('orders')
            .update({
              omnivore_pos_id: omnivorePosId,
              global_pos_id: `${siteId}-${omnivorePosId}`,
              additional_properties: mergedAp,
            })
            .eq('id', linkCand.id)
            .eq('site_id', siteId)
            .is('omnivore_pos_id', null)
            .select('id');
          if (linkErr) {
            logger.error({ error: linkErr, site_id: siteId, omnivore_pos_id: omnivorePosId }, 'omnivore link-by-name: update failed');
            skipped++;
          } else if (linked && linked.length > 0) {
            logger.info({ site_id: siteId, order_id: linkCand.id, omnivore_pos_id: omnivorePosId }, 'omnivore link-by-name: adopted MCM order (no duplicate)');
            updated++;
          } else {
            // El outbound linkeó concurrentemente → ya correcto, sin insertar.
            skipped++;
          }
          continue; // NO insertar: la orden quedó (o ya estaba) linkeada.
        }

        order.site_id = siteId;

        // POS-originada nueva: si el site tiene table-service y es dine-in/tab, marcarla
        // `omnivore_managed` → futuros pulls la mergean y el mesero la edita desde O&P.
        if (tableServiceEnabled && (order.experience === 'qe' || order.experience === 'tab')) {
          (order as any).additional_properties = {
            ...((order as any).additional_properties ?? {}),
            omnivore_managed: true,
          };
        }

        // FIX 2º cheque (2026-07-14): si la orden va linkeada al floor entra al índice único
        // (table_id, check_number) de cheques ABIERTOS; el mapper no emite check_number
        // (default 1), así que el 2º cheque abierto de una mesa fallaba con 23505 en cada
        // ciclo y nunca entraba a MCM. Asignar el siguiente libre + retry acotado en 23505
        // (mismo patrón que open-table-order). Sin table_id el índice no aplica → 1 intento,
        // flujo idéntico al anterior.
        const INSERT_ATTEMPTS = floorEl ? 3 : 1;
        let upsertError: any = null;
        for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
          if (floorEl) {
            const siblings = await openCheckNumbersForTable(siteId, floorEl.id);
            if (siblings) (order as any).check_number = nextCheckNumber(siblings);
          }
          order.id = Math.floor(Math.random() * 10_000_000_000_000_000);
          const { error } = await supabase.from('orders').upsert(
            {
              ...order,
              omnivore_pos_id: omnivorePosId,
              global_pos_id: `${siteId}-${omnivorePosId}`,
            },
            { onConflict: 'site_id,omnivore_pos_id', ignoreDuplicates: true }
          );
          upsertError = error ?? null;
          // Con ignoreDuplicates en (site_id,omnivore_pos_id), un 23505 aquí viene de OTRA
          // constraint (check_number tomado por una carrera, o el PK random) → recalcular ambos.
          if (!upsertError || (upsertError as any).code !== '23505') break;
        }
        if (upsertError) {
          logger.error({ error: upsertError, site_id: siteId, omnivore_pos_id: omnivorePosId }, 'omnivore upsert: insert failed');
          skipped++;
        } else {
          inserted++;
          // WS-8: re-consultar el id real (ignoreDuplicates puede no devolver fila) y
          // registrar el pago externo si la orden nació ya cobrada en Omnivore.
          if (order.payment_status === 'fulfilled' && Number(order.paid ?? 0) > 0) {
            const { data: row } = await supabase
              .from('orders')
              .select('id')
              .eq('site_id', siteId)
              .eq('omnivore_pos_id', omnivorePosId)
              .limit(1)
              .maybeSingle();
            if (row?.id) await recordExternalOmnivorePaymentIfNeeded(siteId, row.id, order);
          }
        }
      }
    } catch (err) {
      logger.error(
        { err, site_id: siteId, omnivore_pos_id: omnivorePosId },
        'omnivore upsert: unexpected error — skipping order'
      );
      skipped++;
    }
  }

  return { inserted, updated, skipped };
}
