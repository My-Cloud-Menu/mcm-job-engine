import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import { idempotencyId, getTicketTotals, persistInjectionError, willTerminate } from './shared';

/**
 * Step 3 of 3 — apply the payment(s) to the ticket.
 *
 * `jobPayload.payments` is the exact payment array the legacy All-In-One nested
 * under `payments` — for the create flow that is a single 3rd-party payment
 * with `full: true` (pays the whole balance and, with auto_close, closes the
 * ticket). Posting it to the standalone `POST /tickets/:id/payments` is
 * functionally identical.
 *
 * Idempotency (header-independent): if the ticket balance is already 0, or it
 * already carries at least as many payments as we intend to post, a prior
 * attempt succeeded — skip to avoid `excessive_payment` on retry.
 */
registerHandler('omnivore', 'create_payment', async ({ jobPayload, context, job, step }) => {
  const orderId = jobPayload['order_id'];
  const ticketId = (context['create_order'] as Record<string, unknown> | undefined)?.[
    'omnivore_ticket_id'
  ] as string | undefined;
  if (!ticketId) {
    throw new HandlerError('Missing omnivore_ticket_id in context', 'MISSING_CONTEXT', false);
  }

  const payments = jobPayload['payments'];
  if (!Array.isArray(payments) || payments.length === 0) {
    return { applied: 0, skipped: 'no_payments' };
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), job.correlation_id);

  try {
    // Resume guard: already paid / already has the payments we intend to post.
    const totals = await getTicketTotals(client, ticketId);
    if (totals.due === 0 || totals.paymentCount >= payments.length) {
      return { applied: 0, skipped: 'already_paid', due: totals.due, payments: totals.paymentCount };
    }

    const baseId = idempotencyId(step, job, 'create_payment');
    const paymentIds: Array<string | null> = [];
    for (let i = 0; i < payments.length; i++) {
      const res = await client.post<{ id: string }>(`/tickets/${ticketId}/payments`, payments[i], {
        headers: { 'Idempotency-Id': `${baseId}:${i}` },
      });
      assertNoOmnivoreErrors(res.data);
      paymentIds.push(res.data?.id ?? null);
    }

    return { applied: paymentIds.length, payment_ids: paymentIds };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapOmnivoreError(err, 'OMNIVORE_CREATE_PAYMENT_FAILED');
    if (willTerminate(he.retryable, step)) {
      await persistInjectionError(job.site_id, orderId, he);
    }
    throw he;
  }
});
