import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { summarizeCloverPayment } from './payment-mapper';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { enqueuePaymentInjection } from '../../../enqueue/helpers';
import { buildOmnivorePaymentBody } from '../../omnivore/inject/build-payment-body';

/**
 * Forward a Clover-terminal payment (with its tip) to Omnivore, if the order
 * originated in Omnivore (carries `orders.pos_id`) and Omnivore is active. The
 * pull historically stopped at inserting the MCM payment, so the Omnivore ticket
 * never received the payment — silently (no job → nothing in /admin/jobs). This
 * enqueues a retryable/idempotent `omnivore.payment_injection` job; the
 * "applied" marker is stored under `additional_properties.omnivore_payment_id`
 * (NOT `pos_id`, which here holds the Clover payment id). Non-fatal: a failure
 * to enqueue never breaks the pull.
 */
async function maybeForwardPaymentToOmnivore(
  siteId: number,
  order: { id: number | string; pos_id?: string | null },
  mcmPaymentId: string | number,
  payment: { total: string; tip: string; source: string; reference: string }
): Promise<void> {
  try {
    // The order must carry an Omnivore ticket (= it was born in Omnivore).
    if (!order.pos_id) return;

    // Omnivore active? `getSiteIntegrationConfig` throws NO_INTEGRATION when not;
    // catch it so the pull loop is NEVER aborted (benign "no omnivore here").
    let omnivoreConfig: Record<string, unknown> | null = null;
    try {
      omnivoreConfig = (await getSiteIntegrationConfig(siteId, 'omnivore', 'pos')).config;
    } catch {
      return; // Omnivore not active for this site.
    }

    // Anti double-pay: if an omnivore `order_injection` job exists for this order,
    // that job already applies the payment in its `create_payment` step (mirror of
    // the edge `enqueueOmnivorePaymentInjection` guard).
    const { data: injJobs } = await supabase
      .from('integration_jobs')
      .select('id')
      .eq('site_id', siteId)
      .eq('integration', 'omnivore')
      .eq('job_type', 'order_injection')
      .eq('reference_id', String(order.id))
      .limit(1);
    if (injJobs && injJobs.length > 0) return;

    const body = buildOmnivorePaymentBody(
      {
        id: mcmPaymentId,
        total: payment.total,
        tip: payment.tip,
        source: payment.source,
        method: 'ecr-card',
        reference: payment.reference,
      },
      omnivoreConfig
    );

    await enqueuePaymentInjection({
      siteId,
      paymentId: mcmPaymentId,
      orderId: order.id,
      ticketId: order.pos_id,
      posProvider: 'omnivore',
      payment: body,
      posIdField: 'additional_properties.omnivore_payment_id',
      maxAttempts: 4, // 1 + hasta 3 reintentos
    });
    logger.info(
      { site_id: siteId, order_id: order.id, mcm_payment_id: mcmPaymentId },
      'clover pull: enqueued Omnivore payment forward (with tip)'
    );
  } catch (err) {
    logger.error(
      { err, site_id: siteId, order_id: order.id, mcm_payment_id: mcmPaymentId },
      'clover pull: failed to enqueue Omnivore payment forward (non-fatal)'
    );
  }
}

export interface PullResult {
  created: number;
  updated: number;
  skipped: number;
  maxModifiedTime: number;
  // WS-12/F9b: modifiedTime más viejo de un pago DIFERIDO (su orden aún no existe en
  // MCM). El caller no debe avanzar el watermark más allá de esto para no perderlo.
  oldestDeferred: number | null;
}

/**
 * Upserts Clover payments into MCM, deduped on `clover_payment_map`
 * (UNIQUE site_id, clover_payment_id). Handles:
 *  - new Clover-originated payments → create MCM payment + mark order paid + map row
 *  - anti-loop: payments MCM injected (already have `payments.pos_id == clover id`,
 *    or already mapped) are NOT re-created
 *  - voids/refunds: reflect changed `voided`/`total_refunded` on the MCM payment + map
 *  - orders not yet synced to Clover → left for a later cycle (never lost)
 */
export async function upsertCloverPayments(siteId: number, cloverPayments: unknown[]): Promise<PullResult> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let maxModifiedTime = 0;
  let oldestDeferred: number | null = null;

  for (const raw of cloverPayments) {
    try {
      const p = summarizeCloverPayment(raw as any);
      if (p.modifiedTime > maxModifiedTime) maxModifiedTime = p.modifiedTime;

      if (!p.cloverPaymentId || !p.cloverOrderId) {
        skipped++;
        continue;
      }
      // WS-12/F30: los ids de Clover son alfanuméricos. Saltar uno malformado evita
      // que un valor con comas/paréntesis rompa el filtro `.or(...)` de abajo.
      if (!/^[A-Za-z0-9_-]+$/.test(p.cloverOrderId)) {
        logger.warn({ site_id: siteId, clover_order_id: p.cloverOrderId }, 'clover pull: skipping payment with malformed clover order id');
        skipped++;
        continue;
      }
      // Only successful payments (or ones that became voided) are relevant.
      if (p.result && p.result !== 'SUCCESS' && !p.voided) {
        skipped++;
        continue;
      }

      // Already known (mapped) → reflect void/refund changes only.
      const { data: mapRow } = await supabase
        .from('clover_payment_map')
        .select('id, mcm_payment_id, voided, total_refunded')
        .eq('site_id', siteId)
        .eq('clover_payment_id', p.cloverPaymentId)
        .maybeSingle();

      if (mapRow) {
        // WS-10/F24 (auditoría 2026-06-09): detectar también ajustes de PROPINA
        // hechos en Clover tras cerrar (antes solo se miraba voided/refund → el tip
        // nuevo nunca llegaba a MCM). Compara la propina actual del pago MCM con la
        // de Clover.
        let tipChanged = false;
        if (mapRow.mcm_payment_id != null) {
          const { data: mcmPay } = await supabase
            .from('payments')
            .select('tip')
            .eq('id', mapRow.mcm_payment_id)
            .eq('site_id', siteId)
            .maybeSingle();
          if (mcmPay) {
            tipChanged = Math.round(Number(mcmPay.tip ?? 0) * 100) !== p.tip;
          }
        }
        const changed =
          Boolean(mapRow.voided) !== p.voided ||
          Number(mapRow.total_refunded ?? 0) !== p.totalRefunded ||
          tipChanged;
        if (changed) {
          await supabase
            .from('clover_payment_map')
            .update({ voided: p.voided, total_refunded: p.totalRefunded, modified_time: p.modifiedTime })
            .eq('id', mapRow.id);
          if (mapRow.mcm_payment_id != null) {
            await supabase
              .from('payments')
              .update({
                total_refunded: (p.totalRefunded / 100).toFixed(2),
                ...(tipChanged ? { tip: (p.tip / 100).toFixed(2), total: (p.amount / 100).toFixed(2) } : {}),
              })
              .eq('id', mapRow.mcm_payment_id)
              .eq('site_id', siteId);
          }
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      // Anti-loop: MCM injected this payment (its pos_id == clover payment id) but
      // the map row hasn't been written yet (race). Record the map, don't duplicate.
      const { data: injected } = await supabase
        .from('payments')
        .select('id')
        .eq('site_id', siteId)
        .eq('pos_id', p.cloverPaymentId)
        .maybeSingle();
      if (injected) {
        await supabase.from('clover_payment_map').upsert(
          {
            site_id: siteId,
            clover_payment_id: p.cloverPaymentId,
            mcm_payment_id: injected.id,
            external_payment_id: p.externalPaymentId,
            voided: p.voided,
            total_refunded: p.totalRefunded,
            modified_time: p.modifiedTime,
          },
          { onConflict: 'site_id,clover_payment_id', ignoreDuplicates: false }
        );
        skipped++;
        continue;
      }

      // Find the MCM order (push: clover_ticket_id; pull: clover_pos_id).
      // Bug 2 (#10349): traemos `total` y `channel` para decidir fulfilled vs partial.
      let { data: order } = await supabase
        .from('orders')
        .select('id, total, channel, pos_id')
        .eq('site_id', siteId)
        .or(`clover_ticket_id.eq.${p.cloverOrderId},clover_pos_id.eq.${p.cloverOrderId}`)
        .limit(1)
        .maybeSingle();

      // Supplemental fallback: a SUPPLEMENTAL Clover order id matches neither
      // clover_ticket_id nor clover_pos_id — find the parent MCM order via the
      // `additional_properties.clover_supplemental.supplements[].clover_order_id`
      // manifest. The payment then lands on the SAME MCM order (orders_ids:
      // [order.id]), so the cumulative-paid math (Σ payments vs order.total)
      // naturally sums primary + supplement with no double-count.
      if (!order) {
        const { data: suppOrder } = await supabase
          .from('orders')
          .select('id, total, channel, pos_id')
          .eq('site_id', siteId)
          .contains('additional_properties', {
            clover_supplemental: { supplements: [{ clover_order_id: p.cloverOrderId }] },
          })
          .limit(1)
          .maybeSingle();
        order = suppOrder ?? null;
      }

      if (!order) {
        // Order not synced to Clover yet — leave for a later cycle (don't lose it).
        // WS-12/F9b: registrar el modifiedTime más viejo diferido para que el caller
        // NO avance el watermark más allá → se re-trae hasta que la orden aparezca.
        if (oldestDeferred === null || p.modifiedTime < oldestDeferred) {
          oldestDeferred = p.modifiedTime;
        }
        skipped++;
        continue;
      }

      // WS-1/F6 (auditoría 2026-06-09): blindaje anti-doble-conteo. Si este pago de
      // Clover lleva NUESTRO `externalPaymentId` (= lo originó MCM) y la orden ya tiene
      // un pago MCM `completed` sin `pos_id` (la inyección lo creó en Clover pero murió
      // antes de linkear), ES el mismo pago: lo LINKEAMOS (pos_id + map) en vez de
      // insertar una 2ª fila. Pagos del staff en el device (sin externalPaymentId) o
      // splits genuinos no entran aquí y se insertan normal.
      if (p.externalPaymentId) {
        const { data: unlinkedMcm } = await supabase
          .from('payments')
          .select('id')
          .eq('site_id', siteId)
          .contains('orders_ids', [order.id])
          .eq('status', 'completed')
          .is('pos_id', null)
          .limit(1)
          .maybeSingle();
        if (unlinkedMcm) {
          await supabase
            .from('payments')
            .update({ pos_id: p.cloverPaymentId })
            .eq('id', unlinkedMcm.id)
            .eq('site_id', siteId);
          await supabase.from('clover_payment_map').upsert(
            {
              site_id: siteId,
              clover_payment_id: p.cloverPaymentId,
              mcm_payment_id: unlinkedMcm.id,
              external_payment_id: p.externalPaymentId,
              voided: p.voided,
              total_refunded: p.totalRefunded,
              modified_time: p.modifiedTime,
            },
            { onConflict: 'site_id,clover_payment_id', ignoreDuplicates: false }
          );
          skipped++;
          continue;
        }
      }

      const totalInDollars = (p.amount / 100).toFixed(2);
      const tipInDollars = (p.tip / 100).toFixed(2);
      const now = new Date().toISOString();

      // Fix 1 (concurrencia): UPSERT idempotente sobre el UNIQUE parcial
      // payments(site_id,pos_id) WHERE pos_id IS NOT NULL (migración 016). Dos
      // pulls concurrentes del MISMO pago Clover convergen en UNA fila (la 2ª
      // colisiona → DO UPDATE → devuelve el MISMO id), así ambos forwards usan el
      // mismo mcmPaymentId → `pos_pay:omnivore:{id}` deduplica → una sola
      // inyección a Omnivore (sin doble cargo). Antes era `.insert()` plano →
      // filas duplicadas bajo solape.
      const { data: mcmPayment, error: insErr } = await supabase
        .from('payments')
        .upsert(
          {
            site_id: siteId,
            orders_ids: [order.id],
            method: 'ecr-card',
            // WS-1/F7 (auditoría 2026-06-09): no registrar como `completed` un pago que
            // ya llega anulado desde Clover (antes se insertaba siempre `completed`).
            status: p.voided ? 'voided' : 'completed',
            total: totalInDollars,
            tip: tipInDollars,
            reference: p.cloverPaymentId,
            source: p.cardType,
            employee: {},
            data: { cloverPayment: raw },
            additional_properties: {},
            date_created: now,
            date_updated: now,
            total_refunded: (p.totalRefunded / 100).toFixed(2),
            pos_id: p.cloverPaymentId,
          },
          { onConflict: 'site_id,pos_id' }
        )
        .select('id')
        .single();

      if (insErr) {
        logger.error({ insErr, site_id: siteId, clover_payment_id: p.cloverPaymentId }, 'clover pull: payment upsert failed');
        skipped++;
        continue;
      }

      if (!p.voided) {
        // Bug 2 (#10349): NO marcar la orden pagada-completa incondicionalmente. Antes
        // ponía fulfilled/check-closed con el monto de ESTE pago, aunque fuera < total.
        // Acumulamos Σ(pagos completed) y comparamos contra `order.total`: el pago de
        // Clover guarda el monto base (sin tip) en `payments.total`, así que la suma de
        // `total` es la contribución correcta al total de la orden (que excluye tip).
        const { data: completedPays } = await supabase
          .from('payments')
          .select('total')
          .eq('site_id', siteId)
          .contains('orders_ids', [order.id])
          .eq('status', 'completed');
        const cumulativePaid = (completedPays || []).reduce(
          (acc, pay: any) => acc + Number(pay.total ?? 0),
          0
        );
        const orderTotal = Number(order.total ?? 0);
        const EPS = 0.02; // tolerancia de centavos por redondeo de tax/reconstrucción
        const fullyPaid = orderTotal > 0 && cumulativePaid >= orderTotal - EPS;
        const isPos = String(order.channel ?? '').toLowerCase() === 'pos';

        const patch: Record<string, unknown> = {
          clover_payment_id: p.cloverPaymentId,
          paid: cumulativePaid.toFixed(2),
          payment_status: fullyPaid ? 'fulfilled' : 'partially_fulfilled',
        };
        // Solo cerrar el cheque si el pago cubre el total (y es del canal POS).
        if (fullyPaid && isPos) patch.status = 'check-closed';

        await supabase
          .from('orders')
          .update(patch)
          .eq('id', order.id)
          .eq('site_id', siteId);
      }

      await supabase.from('clover_payment_map').upsert(
        {
          site_id: siteId,
          clover_payment_id: p.cloverPaymentId,
          mcm_payment_id: mcmPayment?.id ?? null,
          external_payment_id: p.externalPaymentId,
          voided: p.voided,
          total_refunded: p.totalRefunded,
          modified_time: p.modifiedTime,
        },
        { onConflict: 'site_id,clover_payment_id', ignoreDuplicates: false }
      );

      // Forward the (non-voided) Clover-terminal payment + tip to Omnivore so the
      // source ticket gets paid. Non-fatal; only fires when the order has an
      // Omnivore ticket and Omnivore is active.
      if (!p.voided && mcmPayment?.id) {
        await maybeForwardPaymentToOmnivore(
          siteId,
          { id: order.id, pos_id: (order as any).pos_id },
          mcmPayment.id,
          { total: totalInDollars, tip: tipInDollars, source: p.cardType, reference: p.cloverPaymentId }
        );
      }
      created++;
    } catch (err) {
      logger.error({ err, site_id: siteId }, 'clover pull: unexpected error — skipping payment');
      skipped++;
    }
  }

  return { created, updated, skipped, maxModifiedTime, oldestDeferred };
}
