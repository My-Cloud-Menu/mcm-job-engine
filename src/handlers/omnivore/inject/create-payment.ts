import { registerHandler } from '../../registry';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { logger } from '../../../lib/logger';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import { idempotencyId, getTicketTotals, appendOrderSystemNote } from './shared';
import { resolveInjectionConfig } from './connection';
import {
  buildInjectionStatus,
  clearInjectionStatus,
  persistInjectionStatus,
  readOrderGuard,
  statusForFailure,
} from './injection-status';

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/**
 * Tope de cada pago al saldo del ticket (I3, mismo criterio que el pago suelto `payment_injection`). PURA.
 * Devuelve los cuerpos a postear y los ajustes hechos. Un pago que ya no cabe (saldo agotado) no se postea.
 */
export function capPaymentsToDue(
  payments: Array<Record<string, unknown>>,
  due: number | null
): { toPost: Array<Record<string, unknown>>; adjustments: Array<{ index: number; requested: number; applied: number }> } {
  if (due == null || !Number.isFinite(due)) return { toPost: payments, adjustments: [] };
  let remaining = due;
  const toPost: Array<Record<string, unknown>> = [];
  const adjustments: Array<{ index: number; requested: number; applied: number }> = [];
  payments.forEach((p, index) => {
    const requested = Number(p['amount'] ?? 0);
    if (remaining <= 0) {
      if (requested > 0) adjustments.push({ index, requested, applied: 0 });
      return;
    }
    if (requested > remaining) {
      toPost.push({ ...p, amount: remaining });
      adjustments.push({ index, requested, applied: remaining });
      remaining = 0;
      return;
    }
    toPost.push(p);
    remaining -= requested;
  });
  return { toPost, adjustments };
}

/**
 * Step 3 of 3 — apply the payment(s) to the ticket.
 *
 * `jobPayload.payments` is the exact payment array the edge builder froze
 * (`getPaymentStructureForCreateOmnivoreTicket`): a 3rd-party payment with `amount` (order total minus tip, in cents)
 * plus `tip`. It does NOT use `full: true`; the ticket closes once `amount` covers the due.
 *
 * Idempotency and money safety (I3, Misión Omnivore Multisucursal):
 * - the ticket balance is read first: due 0 ⇒ already paid, nothing is posted (a retry after a lost answer never
 *   charges twice);
 * - each payment is capped to the remaining due (system note on the order when it is adjusted);
 * - after posting, if the ticket still has a balance the order is marked «needs action» so the staff closes it.
 * When all 3 steps finish, the injection status on the order is cleared (R7). If this step dies with the ticket already
 * in the kitchen, the order says so explicitly (I4).
 */
registerHandler('omnivore', 'create_payment', async ({ jobPayload, context, job, step }) => {
  const orderId = jobPayload['order_id'];
  const createOrder = context['create_order'] as Record<string, unknown> | undefined;
  const ticketId = createOrder?.['omnivore_ticket_id'] as string | undefined;
  if (!ticketId && createOrder?.['skipped']) {
    if (createOrder['skipped'] === 'order_cancelled') await clearInjectionStatus(job.site_id, orderId);
    return { skipped: 'upstream_skipped' };
  }

  try {
    if (!ticketId) {
      throw new HandlerError('Missing omnivore_ticket_id in context', 'MISSING_CONTEXT', false);
    }
    const addItems = context['add_items'] as Record<string, unknown> | undefined;
    if (addItems?.['skipped'] === 'resolved_manually' || addItems?.['skipped'] === 'order_cancelled_with_ticket') {
      return { skipped: 'upstream_skipped' };
    }
    const guard = await readOrderGuard(job.site_id, orderId);
    if (guard.stop === 'resolved') return { skipped: 'resolved_manually' };
    if (guard.stop === 'cancelled') {
      await persistInjectionStatus(
        job.site_id,
        orderId,
        buildInjectionStatus({ state: 'needs_action', step: 'create_payment', code: 'ORDER_CANCELLED_WITH_TICKET', ticketId })
      );
      return { skipped: 'order_cancelled_with_ticket', order_status: guard.status };
    }

    const payments = jobPayload['payments'];
    if (!Array.isArray(payments) || payments.length === 0) {
      await clearInjectionStatus(job.site_id, orderId);
      return { applied: 0, skipped: 'no_payments' };
    }

    const { config } = await resolveInjectionConfig(job, jobPayload);
    const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), job.correlation_id);

    const totals = await getTicketTotals(client, ticketId);
    if (totals.due != null && totals.due <= 0) {
      await clearInjectionStatus(job.site_id, orderId);
      return { applied: 0, skipped: 'already_paid', due: totals.due, payments: totals.paymentCount };
    }
    if (totals.paymentCount >= payments.length) {
      // Un intento anterior ya aplicó los pagos y aun así queda saldo: no se cobra otra vez; lo cierra el staff.
      await persistInjectionStatus(
        job.site_id,
        orderId,
        buildInjectionStatus({
          state: 'needs_action',
          step: 'create_payment',
          code: 'TICKET_DUE_REMAINING',
          detail: `Saldo ${usd(totals.due ?? 0)} con ${totals.paymentCount} pago(s) ya aplicados.`,
          ticketId,
        })
      );
      return { applied: 0, skipped: 'payments_already_present', due: totals.due, payments: totals.paymentCount };
    }

    const { toPost, adjustments } = capPaymentsToDue(payments as Array<Record<string, unknown>>, totals.due);
    for (const a of adjustments) {
      const nota =
        `Pago al POS ajustado al saldo del ticket ${ticketId}: cobrado en MCM ${usd(a.requested)}, ` +
        `aplicado en el POS ${usd(a.applied)} (diferencia ${usd(a.requested - a.applied)}). Revisar a mano.`;
      logger.warn({ site_id: job.site_id, order_id: orderId, ticket_id: ticketId, ...a }, 'omnivore create_payment: amount capped to ticket due');
      await appendOrderSystemNote(job.site_id, orderId, nota);
    }

    const baseId = idempotencyId(step, job, 'create_payment');
    const paymentIds: Array<string | null> = [];
    for (let i = 0; i < toPost.length; i++) {
      const res = await client.post<{ id: string }>(`/tickets/${ticketId}/payments`, toPost[i], {
        headers: { 'Idempotency-Id': `${baseId}:${i}` },
      });
      assertNoOmnivoreErrors(res.data);
      paymentIds.push(res.data?.id ?? null);
    }

    // ¿Quedó saldo? (MCM cobró menos que el total de Aloha.) El job termina; el staff cierra el ticket en Aloha.
    let dueAfter: number | null = null;
    try {
      dueAfter = (await getTicketTotals(client, ticketId)).due;
    } catch {
      dueAfter = null; // sin lectura no se marca nada; los pagos ya entraron
    }
    if (dueAfter != null && dueAfter > 0) {
      await persistInjectionStatus(
        job.site_id,
        orderId,
        buildInjectionStatus({
          state: 'needs_action',
          step: 'create_payment',
          code: 'TICKET_DUE_REMAINING',
          detail: `Saldo ${usd(dueAfter)} después de aplicar ${paymentIds.length} pago(s).`,
          ticketId,
        })
      );
    } else {
      await clearInjectionStatus(job.site_id, orderId);
    }

    return {
      applied: paymentIds.length,
      payment_ids: paymentIds,
      ...(adjustments.length ? { adjustments } : {}),
      ...(dueAfter != null ? { due_after: dueAfter } : {}),
    };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapOmnivoreError(err, 'OMNIVORE_CREATE_PAYMENT_FAILED');
    const failure = statusForFailure(he, step, 'create_payment', { ticketId: ticketId ?? null });
    // I4: si el paso muere con el ticket ya en cocina, se dice así («ticket sin pago»), con el código original al lado.
    const status =
      failure.state === 'failed' && ticketId
        ? buildInjectionStatus({
            state: 'needs_action',
            step: 'create_payment',
            code: 'TICKET_WITHOUT_PAYMENT',
            causeCode: he.code,
            detail: he.message,
            attempt: failure.attempt,
            maxAttempts: failure.max_attempts,
            ticketId,
            responseBody: he.responseBody,
          })
        : failure;
    await persistInjectionStatus(job.site_id, orderId, status);
    throw he;
  }
});
