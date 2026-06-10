import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { convertOmnivoreOrderToMCMOrder } from './order-mapper';

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
  config: any
): Promise<UpsertResult> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const raw of omnivoreOrders) {
    // Per-order guard: a single malformed ticket must not fail the whole batch.
    let omnivorePosId = '(unknown)';
    try {
      const order = convertOmnivoreOrderToMCMOrder(raw as any, config);
      omnivorePosId = order.pos_id as string;

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
        // preservamos sus campos de pago para que el sync NUNCA la reabra/des-pague
        // (Omnivore la reporta abierta si la inyección del pago falló). Line items
        // y totales sí pueden seguir sincronizando.
        if (await orderHasAppliedPayment(existing.site_id, existing.id)) {
          order.status = existing.status;
          order.payment_status = existing.payment_status;
          order.paid = existing.paid;
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
        const randomNumberId = Math.floor(Math.random() * 10_000_000_000_000_000);
        order.site_id = siteId;
        order.id = randomNumberId;

        const { error: upsertError } = await supabase.from('orders').upsert(
          {
            ...order,
            omnivore_pos_id: omnivorePosId,
            global_pos_id: `${siteId}-${omnivorePosId}`,
          },
          { onConflict: 'site_id,omnivore_pos_id', ignoreDuplicates: true }
        );
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
