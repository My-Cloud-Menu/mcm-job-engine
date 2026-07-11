import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { supabase } from '../../../lib/supabase';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import { idempotencyId, persistPaymentIssue, reconcileOrderIssues, willTerminate } from './shared';

/**
 * Standalone payment injection (replaces the legacy `sendPaymentToOmnivore`).
 *
 * Applies an already-completed MCM payment to an existing Omnivore ticket. The
 * edge producer (`enqueueOmnivorePaymentInjection`) pre-builds the exact 3rd-
 * party payment body (tender mapping, amount/tip in cents, comment, cash
 * override) and freezes it under `jobPayload.payment`, along with `ticket_id`
 * (= `orders.pos_id`) and the MCM `payment_id` / `order_id`.
 *
 * Idempotency (header-independent): if the MCM payment already carries a
 * `pos_id`, it was applied — skip. On success we persist the Omnivore payment
 * id back to `payments.pos_id` (parity with the legacy flow).
 */
/**
 * Where the "applied to Omnivore" marker lives on the `payments` row. Default
 * `pos_id` (POS-originated payments). The Clover-pull → Omnivore forward passes
 * `additional_properties.omnivore_payment_id` because for a Clover-terminal
 * payment `pos_id` already holds the CLOVER payment id (upsert-payments.ts:212),
 * so reusing it would make the resume guard skip immediately and never apply.
 */
const OMNIVORE_MARKER_FIELD = 'additional_properties.omnivore_payment_id';

async function readOmnivoreApplied(
  siteId: number,
  paymentId: unknown,
  posIdField: string
): Promise<string | null> {
  if (posIdField === OMNIVORE_MARKER_FIELD) {
    const { data } = await supabase
      .from('payments')
      .select('additional_properties')
      .eq('id', paymentId)
      .eq('site_id', siteId)
      .maybeSingle();
    const ap = (data?.additional_properties ?? {}) as Record<string, unknown>;
    return (ap.omnivore_payment_id as string) ?? null;
  }
  const { data } = await supabase
    .from('payments')
    .select('pos_id')
    .eq('id', paymentId)
    .eq('site_id', siteId)
    .maybeSingle();
  return (data?.pos_id as string) ?? null;
}

async function writeOmnivoreApplied(
  siteId: number,
  paymentId: unknown,
  posIdField: string,
  value: string
): Promise<void> {
  if (posIdField === OMNIVORE_MARKER_FIELD) {
    const { data } = await supabase
      .from('payments')
      .select('additional_properties')
      .eq('id', paymentId)
      .eq('site_id', siteId)
      .maybeSingle();
    const ap = {
      ...((data?.additional_properties ?? {}) as Record<string, unknown>),
      omnivore_payment_id: value,
    };
    await supabase
      .from('payments')
      .update({ additional_properties: ap })
      .eq('id', paymentId)
      .eq('site_id', siteId);
    return;
  }
  await supabase
    .from('payments')
    .update({ pos_id: value })
    .eq('id', paymentId)
    .eq('site_id', siteId);
}

registerHandler('omnivore', 'payment_injection', async ({ jobPayload, job, step }) => {
  const ticketId = jobPayload['ticket_id'] as string | undefined;
  const paymentId = jobPayload['payment_id'];
  const orderId = jobPayload['order_id'];
  const paymentBody = jobPayload['payment'] as Record<string, unknown> | undefined;
  // Resume marker location (default `pos_id`; Clover-pull forward overrides it).
  const posIdField = (jobPayload['pos_id_field'] as string) || 'pos_id';

  if (!ticketId) {
    throw new HandlerError('payment_injection payload missing ticket_id', 'MISSING_TICKET_ID', false);
  }
  if (!paymentBody || typeof paymentBody !== 'object') {
    throw new HandlerError('payment_injection payload missing payment body', 'MISSING_PAYMENT_BODY', false);
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), job.correlation_id);

  // Resume guard: this MCM payment already has an Omnivore id ⇒ already applied.
  if (paymentId != null) {
    const applied = await readOmnivoreApplied(job.site_id, paymentId, posIdField);
    if (applied) {
      // Ya aplicado: sana el flag de la orden si todos sus pagos están sincronizados.
      await reconcileOrderIssues(job.site_id, orderId, job.id);
      return { skipped: 'already_applied', omnivore_payment_id: applied };
    }
  }

  // Reconcile-before-repost (idempotencia REAL — el header Idempotency-Id está MUERTO en Aloha). Solo en RETRY
  // (attempt_count > 0): un intento previo pudo haber POSTeado el pago con éxito y perdido el ACK (error de red =
  // retryable) → el marker no se escribió → re-POSTear duplicaría el tender en el ticket. Antes de re-postear,
  // buscamos si este pago MCM YA está en el ticket (match por comment único "Invoice #: <invoice|reference>" +
  // amount, ambos del body congelado que Omnivore devuelve tal cual). Si el GET de reconciliación falla, NO
  // POSTeamos (throw retryable) — nunca arriesgamos doble-tender.
  if (paymentId != null && step.attempt_count > 0) {
    let existing: any[] = [];
    try {
      const recon = await client.get<{ _embedded?: { payments?: any[] } }>(`/tickets/${ticketId}/payments`);
      existing = recon.data?._embedded?.payments ?? [];
    } catch (reconErr) {
      throw mapOmnivoreError(reconErr, 'OMNIVORE_PAYMENT_RECONCILE_FAILED');
    }
    const targetComment = (paymentBody as { comment?: string }).comment;
    const targetAmount = (paymentBody as { amount?: number }).amount;
    const already = existing.find(
      (p: any) => !!targetComment && p?.comment === targetComment && Number(p?.amount) === Number(targetAmount),
    );
    if (already) {
      const omniId = already.id != null ? String(already.id) : 'reconciled';
      await writeOmnivoreApplied(job.site_id, paymentId, posIdField, omniId);
      await reconcileOrderIssues(job.site_id, orderId, job.id);
      return { skipped: 'reconciled_lost_ack', omnivore_payment_id: omniId };
    }
  }

  try {
    const res = await client.post<{ id: string }>(`/tickets/${ticketId}/payments`, paymentBody, {
      headers: { 'Idempotency-Id': idempotencyId(step, job, 'payment_injection') },
    });
    assertNoOmnivoreErrors(res.data);

    const omnivorePaymentId = res.data?.id ?? null;
    if (paymentId != null && omnivorePaymentId) {
      await writeOmnivoreApplied(job.site_id, paymentId, posIdField, omnivorePaymentId);
    }
    // Inyección OK: sana el flag de la orden si todos sus pagos están sincronizados.
    await reconcileOrderIssues(job.site_id, orderId, job.id);
    return { omnivore_payment_id: omnivorePaymentId };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapOmnivoreError(err, 'OMNIVORE_PAYMENT_FAILED');
    if (willTerminate(he.retryable, step)) {
      await persistPaymentIssue(job.site_id, orderId, paymentId, he);
    }
    throw he;
  }
});
