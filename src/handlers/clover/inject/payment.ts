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
  const client = createCloverClient(CloverConfigSchema.parse(config), job.correlation_id, job.site_id);

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

  // ── Ancla de reconciliación ────────────────────────────────────────────────────────────
  // `note` sobrevive el viaje de ida y vuelta (verificado contra el merchant). NO se usa
  // `externalPaymentId` porque la edge lo llena con `Invoice #: …`, que es un valor de
  // PRESENTACIÓN y no es único por pago.
  const anclaMcm = paymentId != null ? `mcm:pay:${job.site_id}:${paymentId}` : null;
  const cuerpo: Record<string, unknown> = anclaMcm
    ? { ...paymentBody, note: paymentBody['note'] ? `${paymentBody['note']} ${anclaMcm}` : anclaMcm }
    : { ...paymentBody };

  // ── RECONCILE-BEFORE-REPOST (H-N7) ─────────────────────────────────────────────────────
  // MEDIDO: Clover **ignora** `Idempotency-Key` en `/payments` — dos POST idénticos con la misma
  // clave crearon DOS pagos de $10 sobre la misma orden. El comentario que había aquí afirmaba lo
  // contrario y era la única protección que se creía tener aparte del guard por `pos_id`.
  //
  // El agujero: si el POST triunfa en Clover pero el proceso muere antes de escribir `pos_id`,
  // el reintento COBRA DOS VECES. Así que en cualquier reintento se lee el estado real primero.
  //
  // Regla heredada de Omnivore y es la que importa: **si el GET falla, NO se postea**. Reintentar
  // más tarde es barato; cobrar dos veces, no.
  if (anclaMcm && step.attempt_count > 0) {
    let pagosVivos: any[];
    try {
      const { data } = await client.get<any>(`/orders/${ticketId}?expand=payments`);
      pagosVivos = data?.payments?.elements ?? [];
    } catch (err) {
      const he = mapCloverError(err, 'CLOVER_PAYMENT_RECONCILE_FAILED');
      // Se fuerza retryable: no saber si ya se cobró NUNCA puede degenerar en re-postear.
      throw new HandlerError(
        `clover payment: no se pudo leer el estado de los pagos antes de reintentar (${he.message})`,
        'CLOVER_PAYMENT_RECONCILE_FAILED', true,
      );
    }
    const yaAplicado = pagosVivos.find((pg: any) => String(pg?.note ?? '').includes(anclaMcm));
    if (yaAplicado?.id) {
      const cloverPaymentId = String(yaAplicado.id);
      await supabase.from('payments').update({ pos_id: cloverPaymentId })
        .eq('id', paymentId).eq('site_id', job.site_id);
      await supabase.from('clover_payment_map').upsert(
        { site_id: job.site_id, clover_payment_id: cloverPaymentId, mcm_payment_id: paymentId,
          external_payment_id: externalPaymentId ?? null, voided: false },
        { onConflict: 'site_id,clover_payment_id', ignoreDuplicates: false });
      return { clover_payment_id: cloverPaymentId, reconciled: true };
    }
  }

  try {
    // La cabecera se mantiene por si Clover la implementa algún día, pero **NO es la
    // protección**: está medido que hoy la ignora. La protección es el bloque de arriba.
    const idempotencyHeader = paymentId != null
      ? { headers: { 'Idempotency-Key': `mcm-clover-pay-${job.site_id}-${paymentId}` } }
      : undefined;
    const res = await client.post<{ id: string }>(`/orders/${ticketId}/payments`, cuerpo, idempotencyHeader);
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
