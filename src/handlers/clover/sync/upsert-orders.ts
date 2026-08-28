import { supabase } from '../../../lib/supabase';
import { readAllBySite } from '../../omnivore/sync/inventory/supabase-read';
import { logger } from '../../../lib/logger';
import { convertCloverOrderToMCMOrder } from './order-mapper';
import { mergeCloverManagedLineItems, cloverIdsOf } from './managed-merge';
import { referenciaDeMesa, resolverMesaDesdeTitulo, type MesaCandidata } from './table-match';

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

/** Estados del flujo de cocina de MCM que Clover NO conoce y por tanto no debe pisar. */
const ESTADOS_EN_CURSO = new Set([
  'new-order',
  'in-kitchen',
  'ready-for-pickup',
  'delivery-in-progress',
]);

export async function upsertOrdersFromClover(
  siteId: number,
  cloverOrders: unknown[],
  opts?: {
    tableServiceEnabled?: boolean;
    fetchStartIso?: string;
    /** `id de tasa de Clover -> rate_code de MCM`, invertido desde
     *  `site_integrations.config.cloverTaxRateIdByRateCode`. Sin el, el clasificador cae al
     *  respaldo por nombre. */
    taxRateIdToCode?: Record<string, string> | null;
  }
): Promise<UpsertResult> {
  const tableServiceEnabled = opts?.tableServiceEnabled === true;
  const fetchStartIso = opts?.fetchStartIso;
  const taxRateIdToCode = opts?.taxRateIdToCode ?? null;

  // Mesas del plano de Clover, por NOMBRE. Es lo unico que permite enlazar una orden nacida en
  // el terminal con su mesa: la API de Clover no expone campo de mesa en la orden, solo `title`.
  // Se acota al plano `external_source='clover'` porque el nombre NO es unico por site.
  const mesasClover: MesaCandidata[] = [];
  const mesasCloverPorId = new Map<string, MesaCandidata>();
  {
    const { data: planos } = await supabase
      .from('floor_plans').select('id').eq('site_id', siteId).eq('external_source', 'clover');
    const planIds = (planos ?? []).map((p: any) => p.id);
    if (planIds.length > 0) {
      // `table_number` es IMPRESCINDIBLE: se compara con el numero del titulo y es lo que se guarda
      // en `experience_reference` (la interfaz antepone el "Mesa " ella sola).
      const { data: mesas } = await supabase
        .from('floor_elements')
        .select('id, table_name, table_number, revenue_center_id')
        .eq('site_id', siteId)
        .eq('type', 'table')
        .in('floor_plan_id', planIds);
      for (const m of mesas ?? []) {
        const mesa: MesaCandidata = {
          id: String((m as any).id),
          table_name: (m as any).table_name ?? null,
          table_number: (m as any).table_number ?? null,
          revenue_center_id: (m as any).revenue_center_id ?? null,
        };
        mesasClover.push(mesa);
        mesasCloverPorId.set(mesa.id, mesa);
      }
    }
  }

  /**
   * Enlaza la orden con su mesa a partir del `title` de Clover.
   *
   * ANTI-BUCLE: MCM ESCRIBE ese mismo `title` al inyectar (`"Room 200 · #10001"`). Como aqui solo
   * se acepta un titulo que COINCIDA con una mesa real del plano de Clover, los titulos que pone
   * MCM se descartan solos. Sin coincidencia es no-op, igual que hace Omnivore.
   */
  /**
   * Los CUATRO campos que definen una orden de mesa, escritos juntos. Mismo patron que
   * `transfer-order-table`. Si falta el jsonb `table`, el TICKET DE COCINA imprime "Mesa" a secas,
   * porque su encabezado sale de `order.table.label`.
   */
  const aplicarMesa = (order: any, mesa: MesaCandidata, checkNumber: number) => {
    const etiqueta = String(mesa.table_name ?? mesa.table_number ?? '').trim();
    order.table_id = mesa.id;
    order.table = { id: mesa.id, label: etiqueta, revenue_center_id: mesa.revenue_center_id ?? '' };
    order.check_number = checkNumber;
    // El POS reparte sus listas SOLO por `experience` y el mapa de mesas SOLO por `table_id`: sin
    // esto la orden sale a la vez en el plano y en Pickup. La referencia va con el NUMERO, nunca la
    // etiqueta — la interfaz hace `Mesa ${experience_reference}`.
    order.experience = 'qe';
    order.experience_reference = referenciaDeMesa(mesa);
  };

  /** Siguiente cheque libre. HAY QUE resolverlo: el indice unico `(table_id, check_number)` sobre
   *  cheques abiertos colisiona en cuanto haya dos en la misma mesa. */
  const siguienteCheque = async (tableId: string): Promise<number> => {
    let checkNumber = 1;
    const { data: abiertos } = await supabase
      .from('orders')
      .select('check_number')
      .eq('site_id', siteId)
      .eq('table_id', tableId)
      .is('closed_at', null);
    for (const o of abiertos ?? []) {
      const n = Number((o as any).check_number ?? 1);
      if (Number.isFinite(n) && n >= checkNumber) checkNumber = n + 1;
    }
    return checkNumber;
  };

  const enlazarMesa = async (order: any, cloverOrder: any) => {
    const mesa = resolverMesaDesdeTitulo(cloverOrder?.title, mesasClover);
    if (!mesa) return;
    aplicarMesa(order, mesa, await siguienteCheque(mesa.id));
  };
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

    const order = convertCloverOrderToMCMOrder(cloverOrder, productMap, taxRateIdToCode);
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

      // GUARD ANTI-PARPADEO. El mapper devuelve `new-order` para toda orden que Clover reporte
      // abierta, y este upsert lo escribia en CADA ciclo: una orden que MCM ya habia pasado a
      // `in-kitchen` volvia a `new-order`, y `SEND_ORDER_TO_KITCHEN_AUTOMATICALLY` la devolvia.
      // El sync NO gobierna el flujo de cocina: Clover solo aporta que la orden esta PAGADA.
      // Solo se protegen los estados EN CURSO del flujo de cocina. Una orden que MCM tiene por
      // CERRADA sin pago aplicado SI se deja reabrir — conducta fijada por
      // `clover-payment-guard.test.ts`: si la inyeccion del pago fallo hay que poder cobrarla.
      if ((order as any).status !== 'check-closed' && ESTADOS_EN_CURSO.has(String((existing as any).status))) {
        (order as any).status = (existing as any).status;
      }

      // Solo se enlaza si la orden aun no tiene mesa: una que ya la tiene no se toca jamas.
      if (!(existing as any).table_id) {
        await enlazarMesa(order, cloverOrder);
      } else {
        // Ya tiene mesa: se conserva, pero se ASEGURA la experiencia. Las ordenes atadas antes de
        // este arreglo quedaron en `pu` y saldrian en Pickup para siempre.
        const mesa = mesasCloverPorId.get(String((existing as any).table_id));
        if (mesa) {
          aplicarMesa(order, mesa, (existing as any).check_number ?? 1);
        } else {
          (order as any).table_id = (existing as any).table_id;
          (order as any).table = (existing as any).table;
          (order as any).check_number = (existing as any).check_number;
          (order as any).experience = (existing as any).experience;
          (order as any).experience_reference = (existing as any).experience_reference;
        }
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

        // ── TOTALES: se SUMAN los dos lados, no se elige uno ──────────────────────────────
        //
        // La versión anterior preguntaba «¿tengo yo líneas sin empujar?» y, si la respuesta era
        // sí, DESCARTABA los totales de Clover. Su intención era buena —evitar subvalorar cuando
        // MCM va por delante— pero fallaba cuando van por delante LOS DOS: si el mesero tiene un
        // ítem sin firear Y alguien tecleó algo en el terminal, MCM conservaba su total, que no
        // incluye lo del terminal. Y como `line_items` se escribe SIEMPRE (abajo), ese ítem
        // aparecía en la cuenta SIN SUMAR AL TOTAL → sub-cobro.
        //
        // Y no era una ventana temporal: la condición es de ESTADO. Un ítem retenido (`held`)
        // nunca se firea, así que el desfase podía durar todo el servicio.
        //
        // Se adopta la regla de Omnivore (`omnivore/sync/upsert-orders.ts:335,377`), que lleva
        // meses en producción: la pregunta correcta es **si el ticket del POS tiene líneas**, y
        // cuando las tiene el total es `POS + preview de lo que aún no está en el POS`.
        //
        // OJO con el doble conteo (el mismo fix que Omnivore documenta en :336-341): al preview
        // SÓLO van las líneas que Clover NO tiene, o sea las que no llevan ancla. Las que ya
        // están en el ticket vienen dentro de `order.total` y re-sumarlas duplicaría la cuenta.
        const sinEmpujar = mergedLineItems.filter(
          (li: any) => li.status !== 'voided' && cloverIdsOf(li).length === 0
        );
        const importeLinea = (li: any): number => {
          const t = Number(li?.total);
          if (Number.isFinite(t)) return t;
          // Respaldo: una línea sin `total` aportaría CERO al preview en silencio — otro sub-cobro
          // con distinta cara. Un `total: 0` legítimo (invitación) sí se respeta, porque 0 es finito.
          return Number(li?.price ?? 0) * Number(li?.quantity ?? 1);
        };
        const previewSubtotal = sinEmpujar.reduce((acc: number, li: any) => acc + importeLinea(li), 0);
        const previewTax = sinEmpujar.reduce((acc: number, li: any) => acc + Number(li.total_tax ?? 0), 0);

        // La puerta: ¿tiene el ticket de Clover alguna línea? Si NO (mesa recién abierta — la
        // orden nace vacía en `openCloverTicketForManagedOrder`), se conservan los totales de MCM.
        // Sin esta guarda, cada ciclo escribiría `total = 0` sobre una cuenta con ítems y el
        // mesero vería «Cobrar $0.00».
        const cloverTieneLineas =
          Array.isArray((order as any).line_items) && (order as any).line_items.length > 0;

        const updatePayload: Record<string, unknown> = {
          line_items: mergedLineItems,
          additional_properties: {
            ...((existing as any).additional_properties ?? {}),
            clover_managed: true,
            clover_synced_at: new Date().toISOString(),
          },
        };
        if (cloverTieneLineas) {
          updatePayload.subtotal = Number((order as any).subtotal) + previewSubtotal;
          updatePayload.total = Number((order as any).total) + previewSubtotal + previewTax;
          updatePayload.total_tax = Number((order as any).total_tax) + previewTax;
          updatePayload.discount_total = (order as any).discount_total;
          updatePayload.tax_lines = (order as any).tax_lines;
          // NO se escriben `fee_lines` ni `fee_total`, aunque Omnivore sí los arrastre: el mapper
          // de Clover los emite vacíos (`order-mapper.ts:226,235`) y el 91 % de las órdenes de POS
          // llevan recargo — copiarlo verbatim los borraría. Los recargos ya van DENTRO del total
          // de Clover: la reconciliación del push fuerza `Σ líneas = order.total − propinas`
          // (`clover-helper.ts:1401-1430`). Ver H-N14.
        }
        // Los campos de pago los gobierna el guard anti-doble-cobro de arriba.
        updatePayload.status = (order as any).status;
        // Mesa y experiencia van JUNTAS: el POS reparte por `experience` y el mapa por `table_id`,
        // asi que escribir una sin la otra deja la orden en dos sitios.
        if ((order as any).table_id) {
          updatePayload.table_id = (order as any).table_id;
          updatePayload.table = (order as any).table;
          updatePayload.check_number = (order as any).check_number;
          updatePayload.experience = (order as any).experience;
          updatePayload.experience_reference = (order as any).experience_reference;
        }
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
          (updatePayload.payment_status ?? (existing as any).payment_status) === (existing as any).payment_status &&
          // La MESA tambien cuenta como cambio. Sin esto, una orden que por lo demas no cambio
          // resolvia su mesa correctamente y acto seguido la guarda descartaba la escritura
          // entera: el enlace se calculaba y se tiraba en cada ciclo. Medido en vivo con la orden
          // 10015 (ticket "Mesa 5"), que se quedo sin mesa indefinidamente.
          String(updatePayload.table_id ?? (existing as any).table_id ?? '') ===
            String((existing as any).table_id ?? '') &&
          // La EXPERIENCIA tambien: sin esto una orden ya atada calcularia su `qe` y la guarda
          // descartaria la escritura, dejandola en `pu` (y en el listado de Pickup).
          String(updatePayload.experience ?? (existing as any).experience ?? '') ===
            String((existing as any).experience ?? '') &&
          // Y el TITULO del terminal, que si no nunca llegaria a las ordenes ya existentes.
          String((updatePayload.additional_properties as any)?.clover_title ?? '') ===
            String((existing as any).additional_properties?.clover_title ?? '');
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

      // Orden nacida en el terminal: es el momento natural de enlazarla con su mesa.
      await enlazarMesa(order, cloverOrder);

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
