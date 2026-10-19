import { registerHandler } from '../../registry';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import {
  idempotencyId,
  findOpenTicketIdByName,
  findOpenTicketIdByNameScanAll,
  isOrderUniqueTicketName,
  markStepPostAttempted,
  persistOmnivoreTicketId,
} from './shared';
import { resolveInjectionConfig } from './connection';
import { persistInjectionStatus, readOrderGuard, statusForFailure } from './injection-status';

/** Marca en `integration_jobs.context`: este paso ya mandó (o empezó a mandar) un POST /tickets. */
export const CREATE_ORDER_ATTEMPT_MARKER = 'create_order_post_attempted_at';

/**
 * Step 1 of 3 — open the Omnivore ticket.
 *
 * Architecture (Option A): the edge function pre-builds the exact ticket body
 * (employee / order_type / revenue_center / name / auto_send / user_info) and freezes it under `jobPayload.ticket`.
 * This handler is a thin, idempotent POST of that body to `POST /tickets`; items and payments follow in steps 2 and 3.
 *
 * Duplicate safety (Q2, Misión Omnivore Multisucursal): before the POST a marker is saved in the job context. If the
 * marker exists (a previous attempt may have created the ticket and lost the answer — including after
 * `retry_dead_letter_job`, which resets `attempt_count` to 0) or this is a retry, ALL open tickets are scanned by the
 * deterministic name `MCM {order_id}` and an existing ticket is adopted. If that check fails, the step retries later
 * instead of creating blind.
 *
 * Before anything, the order is re-read: a cancelled order or one the staff resolved by hand is not injected (Q5).
 * Every failure (also config/credentials) is stored on the order with its step, attempt and message (R3).
 */
registerHandler('omnivore', 'create_order', async ({ jobPayload, context, job, step }) => {
  const orderId = jobPayload['order_id'];
  try {
    const guard = await readOrderGuard(job.site_id, orderId);
    if (guard.stop === 'resolved') return { skipped: 'resolved_manually' };
    if (guard.stop === 'cancelled') return { skipped: 'order_cancelled', order_status: guard.status };

    const ticket = jobPayload['ticket'] as Record<string, unknown> | undefined;
    if (!ticket || typeof ticket !== 'object') {
      throw new HandlerError('Omnivore injection payload missing `ticket` body', 'MISSING_TICKET_BODY', false);
    }
    const ticketName = typeof ticket['name'] === 'string' ? (ticket['name'] as string) : undefined;

    const { config, locationId } = await resolveInjectionConfig(job, jobPayload);
    const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), job.correlation_id);

    // Header-independent dedup: only when the ticket name identifies the order.
    if (isOrderUniqueTicketName(ticketName, orderId) && ticketName) {
      let existingId: string | null = null;
      try {
        existingId = await findOpenTicketIdByName(client, ticketName);
      } catch {
        // Aloha rejects eq(name) with bad_query: fall through to the full scan when it matters.
      }
      // Un intento anterior pudo crearlo (marca o reintento), o es un envío forzado que pide buscar antes de crear.
      const mayExist =
        !!context[CREATE_ORDER_ATTEMPT_MARKER] || step.attempt_count > 0 || jobPayload['scan_existing'] === true;
      if (!existingId && mayExist) {
        try {
          existingId = await findOpenTicketIdByNameScanAll(client, ticketName);
        } catch (scanErr) {
          const se = mapOmnivoreError(scanErr, 'TICKET_SEARCH_FAILED');
          throw new HandlerError(
            `Could not verify an existing ticket before creating: ${se.message}`,
            'TICKET_SEARCH_FAILED',
            true,
            se.statusCode,
            se.responseBody
          );
        }
      }
      if (existingId) {
        await persistOmnivoreTicketId(job.site_id, orderId, existingId, locationId);
        return { omnivore_ticket_id: existingId, adopted: true };
      }
    }

    await markStepPostAttempted(job.id, context, CREATE_ORDER_ATTEMPT_MARKER);

    const res = await client.post<{ id: string; ticket_number?: number }>('/tickets', ticket, {
      headers: { 'Idempotency-Id': idempotencyId(step, job, 'create_order') },
    });
    assertNoOmnivoreErrors(res.data);

    const ticketId = res.data?.id;
    if (!ticketId) {
      throw new HandlerError('Omnivore create ticket response missing id', 'MISSING_TICKET_ID', false, res.status, res.data);
    }

    await persistOmnivoreTicketId(job.site_id, orderId, ticketId, locationId);
    return { omnivore_ticket_id: ticketId, ticket_number: res.data?.ticket_number ?? null };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapOmnivoreError(err, 'OMNIVORE_CREATE_TICKET_FAILED');
    await persistInjectionStatus(job.site_id, orderId, statusForFailure(he, step, 'create_order'));
    throw he;
  }
});
