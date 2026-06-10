import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import { idempotencyId, getTicketItemCount, persistInjectionError, willTerminate } from './shared';

/**
 * Step 2 of 3 — add all items to the ticket in a single batched request.
 *
 * `jobPayload.items` is the exact items array built by the edge (meta-items +
 * product items with `menu_item`, `price_level`, `price_per_unit`, `comment`,
 * `modifiers` = `omnivoreParams`, `item_order_mode`) — identical to what the
 * legacy All-In-One nested under `items`. Omnivore's `POST /tickets/:id/items`
 * accepts a `{ items: [...] }` body, so one request preserves the bytes.
 *
 * Idempotency (header-independent): the ticket is created empty by step 1, so
 * if it already has items we know a prior attempt of THIS step succeeded and we
 * skip re-posting (avoids duplicate items on POS engines that don't honour
 * `Idempotency-Id`).
 */
registerHandler('omnivore', 'add_items', async ({ jobPayload, context, job, step }) => {
  const orderId = jobPayload['order_id'];
  const ticketId = (context['create_order'] as Record<string, unknown> | undefined)?.[
    'omnivore_ticket_id'
  ] as string | undefined;
  if (!ticketId) {
    throw new HandlerError('Missing omnivore_ticket_id in context', 'MISSING_CONTEXT', false);
  }

  const items = jobPayload['items'];
  if (!Array.isArray(items)) {
    throw new HandlerError('Omnivore injection payload `items` missing or not an array', 'MISSING_ITEMS', false);
  }
  if (items.length === 0) {
    return { added: 0, skipped: 'no_items' };
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), job.correlation_id);

  try {
    // Resume guard: items already present ⇒ a prior attempt landed them.
    const existingCount = await getTicketItemCount(client, ticketId);
    if (existingCount > 0) {
      return { added: 0, skipped: 'already_present', existing: existingCount };
    }

    const res = await client.post(`/tickets/${ticketId}/items`, { items }, {
      headers: { 'Idempotency-Id': idempotencyId(step, job, 'add_items') },
    });
    assertNoOmnivoreErrors(res.data);

    return { added: items.length };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapOmnivoreError(err, 'OMNIVORE_ADD_ITEMS_FAILED');
    if (willTerminate(he.retryable, step)) {
      await persistInjectionError(job.site_id, orderId, he);
    }
    throw he;
  }
});
