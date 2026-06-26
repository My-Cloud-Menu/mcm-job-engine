import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import {
  idempotencyId,
  findOpenTicketIdByName,
  findOpenTicketIdByNameScan,
  persistOmnivoreTicketId,
  persistInjectionError,
  willTerminate,
} from './shared';

/**
 * Step 1 of 3 — open the Omnivore ticket.
 *
 * Architecture (Option A): the edge function pre-builds the exact ticket body
 * (employee / order_type / revenue_center / name / auto_send / auto_close /
 * user_info) using the legacy `omnivore-helper` and freezes it under
 * `jobPayload.ticket`. This handler is a thin, idempotent POST of that body to
 * `POST /tickets` — an "All In One" call with items/payments omitted (both
 * default to `[]`), so the bytes Omnivore receives for the ticket fields are
 * identical to the legacy flow. Items and payments follow in steps 2 and 3.
 *
 * Duplicate/resume safety (header-independent): if a retry of this step might
 * re-open a ticket whose first attempt actually succeeded, we first look up an
 * open ticket by its deterministic name (`MCM {order_id}`) and adopt it. This
 * guard is skipped when the configured name is not order-unique (e.g. the
 * `MCM-{firstName}` scheme for site 414341196), where we rely on the
 * `Idempotency-Id` header instead.
 */
registerHandler('omnivore', 'create_order', async ({ jobPayload, job, step }) => {
  const ticket = jobPayload['ticket'] as Record<string, unknown> | undefined;
  if (!ticket || typeof ticket !== 'object') {
    throw new HandlerError(
      'Omnivore injection payload missing `ticket` body',
      'MISSING_TICKET_BODY',
      false
    );
  }
  const orderId = jobPayload['order_id'];
  const ticketName = typeof ticket['name'] === 'string' ? (ticket['name'] as string) : undefined;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), job.correlation_id);

  // Header-independent dedup: only when the ticket name encodes the order id.
  const nameIsOrderUnique = !!(ticketName && orderId != null && ticketName.includes(String(orderId)));
  if (nameIsOrderUnique && ticketName) {
    let existingId: string | null = null;
    try {
      existingId = await findOpenTicketIdByName(client, ticketName);
    } catch {
      // Lookup is best-effort; fall through.
    }
    // Aloha RECHAZA eq(name) (findOpenTicketIdByName → null). En un REINTENTO (un intento previo
    // pudo crear el ticket y morir antes de persistir pos_id), escaneamos tickets abiertos y
    // matcheamos en memoria → cierra el duplicado de create_order en Aloha (header muerto).
    if (!existingId && step.attempt_count > 0) {
      try {
        existingId = await findOpenTicketIdByNameScan(client, ticketName);
      } catch {
        // best-effort; fall through to create (Idempotency-Id still applies on POS que lo honran).
      }
    }
    if (existingId) {
      await persistOmnivoreTicketId(job.site_id, orderId, existingId);
      return { omnivore_ticket_id: existingId, adopted: true };
    }
  }

  try {
    const res = await client.post<{ id: string; ticket_number?: number }>('/tickets', ticket, {
      headers: { 'Idempotency-Id': idempotencyId(step, job, 'create_order') },
    });
    assertNoOmnivoreErrors(res.data);

    const ticketId = res.data?.id;
    if (!ticketId) {
      throw new HandlerError(
        'Omnivore create ticket response missing id',
        'MISSING_TICKET_ID',
        false,
        res.status,
        res.data
      );
    }

    await persistOmnivoreTicketId(job.site_id, orderId, ticketId);
    return { omnivore_ticket_id: ticketId, ticket_number: res.data?.ticket_number ?? null };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapOmnivoreError(err, 'OMNIVORE_CREATE_TICKET_FAILED');
    if (willTerminate(he.retryable, step)) {
      await persistInjectionError(job.site_id, orderId, he);
    }
    throw he;
  }
});
