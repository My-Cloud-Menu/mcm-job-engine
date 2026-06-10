import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { supabase } from '../../../lib/supabase';
import { mapCloverError } from '../error-map';
import { persistInjectionError, willTerminate } from './shared';

/**
 * Standalone Clover payment injection (replaces the legacy `sendPaymentToClover`).
 *
 * Applies an already-completed MCM payment to a Clover order. The edge producer
 * (`enqueueCloverPaymentInjection`) pre-builds the 3rd-party body (amount/tip,
 * tender, `externalPaymentId`) and freezes it with `ticket_id` (= the order's
 * `clover_ticket_id` or `pos_id`) and the MCM `payment_id`/`order_id`.
 *
 * Unlike Omnivore, the Clover order-injection job does NOT apply a payment, so
 * this is the only path that pays the Clover order. Idempotency:
 *  - skip if the MCM payment already has a `pos_id` (resume), and
 *  - on success, record `clover_payment_map` (clover_payment_id ↔ mcm_payment_id
 *    + external_payment_id) so the Clover→MCM payment pull can dedup + anti-loop.
 */
registerHandler('clover', 'payment_injection', async ({ jobPayload, job, step }) => {
  const ticketId = jobPayload['ticket_id'] as string | undefined;
  const paymentId = jobPayload['payment_id'];
  const orderId = jobPayload['order_id'];
  const paymentBody = jobPayload['payment'] as Record<string, unknown> | undefined;
  const externalPaymentId = jobPayload['external_payment_id'] as string | undefined;

  if (!ticketId) {
    throw new HandlerError('Clover payment_injection payload missing ticket_id', 'MISSING_TICKET_ID', false);
  }
  if (!paymentBody || typeof paymentBody !== 'object') {
    throw new HandlerError('Clover payment_injection payload missing payment body', 'MISSING_PAYMENT_BODY', false);
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const client = createCloverClient(CloverConfigSchema.parse(config), job.correlation_id);

  // Resume guard: this MCM payment already has a POS id ⇒ already applied.
  if (paymentId != null) {
    const { data: existing } = await supabase
      .from('payments')
      .select('pos_id')
      .eq('id', paymentId)
      .eq('site_id', job.site_id)
      .maybeSingle();
    if (existing?.pos_id) {
      return { skipped: 'already_applied', clover_payment_id: existing.pos_id };
    }
  }

  try {
    // WS-12/F9 (auditoría 2026-06-09): Idempotency-Key estable por pago MCM. Si el
    // POST tuvo éxito pero el proceso murió antes de persistir `pos_id`, el retry
    // re-postea con la MISMA key → Clover deduplica en vez de crear un 2º pago.
    // Complementa el resume-guard (skip si `pos_id` ya existe).
    const idempotencyHeader = paymentId != null
      ? { headers: { 'Idempotency-Key': `mcm-clover-pay-${job.site_id}-${paymentId}` } }
      : undefined;
    const res = await client.post<{ id: string }>(`/orders/${ticketId}/payments`, paymentBody, idempotencyHeader);
    const cloverPaymentId = res.data?.id ?? null;

    if (paymentId != null && cloverPaymentId) {
      await supabase
        .from('payments')
        .update({ pos_id: cloverPaymentId })
        .eq('id', paymentId)
        .eq('site_id', job.site_id);

      await supabase.from('clover_payment_map').upsert(
        {
          site_id: job.site_id,
          clover_payment_id: cloverPaymentId,
          mcm_payment_id: paymentId,
          external_payment_id: externalPaymentId ?? null,
          voided: false,
        },
        { onConflict: 'site_id,clover_payment_id', ignoreDuplicates: false }
      );
    }
    return { clover_payment_id: cloverPaymentId };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapCloverError(err, 'CLOVER_PAYMENT_FAILED');
    if (willTerminate(he.retryable, step)) {
      await persistInjectionError(job.site_id, orderId, he);
    }
    throw he;
  }
});
