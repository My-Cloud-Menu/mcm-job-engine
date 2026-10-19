import { registerHandler } from '../../registry';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import { idempotencyId, getTicketItemCount } from './shared';
import { resolveInjectionConfig } from './connection';
import { buildInjectionStatus, persistInjectionStatus, readOrderGuard, statusForFailure } from './injection-status';

/**
 * Step 2 of 3 — add all items to the ticket in a single batched request.
 *
 * `jobPayload.items` is the exact items array built by the edge (meta-items +
 * product items with `menu_item`, `price_level`, `price_per_unit`, `comment`,
 * `modifiers` = `omnivoreParams`, `item_order_mode`) — identical to what the
 * legacy All-In-One nested under `items`. Omnivore's `POST /tickets/:id/items`
 * accepts a `{ items: [...] }` body, so one request preserves the bytes.
 *
 * Idempotency (header-independent, Q3): the ticket is created empty by step 1. Before posting, the items already on
 * the ticket are counted: as many as expected → a prior attempt landed them, skip; none → post; some but fewer → the
 * ticket is half-loaded: nothing is re-posted (it would duplicate) and the order is marked «needs action».
 */
registerHandler('omnivore', 'add_items', async ({ jobPayload, context, job, step }) => {
  const orderId = jobPayload['order_id'];
  const createOrder = context['create_order'] as Record<string, unknown> | undefined;
  const ticketId = createOrder?.['omnivore_ticket_id'] as string | undefined;
  if (!ticketId && createOrder?.['skipped']) return { skipped: 'upstream_skipped' };

  try {
    if (!ticketId) {
      throw new HandlerError('Missing omnivore_ticket_id in context', 'MISSING_CONTEXT', false);
    }
    const guard = await readOrderGuard(job.site_id, orderId);
    if (guard.stop === 'resolved') return { skipped: 'resolved_manually' };
    if (guard.stop === 'cancelled') {
      await persistInjectionStatus(
        job.site_id,
        orderId,
        buildInjectionStatus({ state: 'needs_action', step: 'add_items', code: 'ORDER_CANCELLED_WITH_TICKET', ticketId })
      );
      return { skipped: 'order_cancelled_with_ticket', order_status: guard.status };
    }

    const items = jobPayload['items'];
    if (!Array.isArray(items)) {
      throw new HandlerError('Omnivore injection payload `items` missing or not an array', 'MISSING_ITEMS', false);
    }
    if (items.length === 0) {
      return { added: 0, skipped: 'no_items' };
    }

    const { config } = await resolveInjectionConfig(job, jobPayload);
    const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), job.correlation_id);

    const existingCount = await getTicketItemCount(client, ticketId);
    if (existingCount >= items.length) {
      return { added: 0, skipped: 'already_present', existing: existingCount };
    }
    if (existingCount > 0) {
      await persistInjectionStatus(
        job.site_id,
        orderId,
        buildInjectionStatus({
          state: 'needs_action',
          step: 'add_items',
          code: 'ITEMS_PARTIAL',
          detail: `El ticket ${ticketId} tiene ${existingCount} de ${items.length} ítems.`,
          attempt: step.attempt_count + 1,
          maxAttempts: step.max_attempts,
          ticketId,
        })
      );
      throw new HandlerError(
        `Ticket ${ticketId} has ${existingCount} of ${items.length} items`,
        'ITEMS_PARTIAL',
        false
      );
    }

    const res = await client.post(`/tickets/${ticketId}/items`, { items }, {
      headers: { 'Idempotency-Id': idempotencyId(step, job, 'add_items') },
    });
    assertNoOmnivoreErrors(res.data);

    return { added: items.length };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapOmnivoreError(err, 'OMNIVORE_ADD_ITEMS_FAILED');
    // ITEMS_PARTIAL ya guardó su estado `needs_action`.
    if (he.code !== 'ITEMS_PARTIAL') {
      await persistInjectionStatus(job.site_id, orderId, statusForFailure(he, step, 'add_items', { ticketId }));
    }
    throw he;
  }
});
