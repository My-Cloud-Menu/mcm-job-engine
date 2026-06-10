import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { convertCloverOrderToMCMOrder } from './order-mapper';

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
  cloverOrders: unknown[]
): Promise<UpsertResult> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let maxModifiedTime = 0;

  for (const raw of cloverOrders) {
    const cloverOrder = raw as any;

    if (cloverOrder.modifiedTime && cloverOrder.modifiedTime > maxModifiedTime) {
      maxModifiedTime = cloverOrder.modifiedTime;
    }

    const order = convertCloverOrderToMCMOrder(cloverOrder);
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

      // GUARD anti-doble-cobro robusto (reemplaza el guard débil previo que confiaba
      // en orders.payment_status + total-unchanged). Si la orden ya tiene un pago
      // aplicado en MCM, preservamos sus campos de pago; line items y totales sí
      // pueden seguir sincronizando.
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
