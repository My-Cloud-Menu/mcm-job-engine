import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { mapCloverError } from '../error-map';
import {
  findCloverOrderIdByExternalRef,
  getOrderCloverState,
  persistCloverTicketId,
  persistInjectionError,
  willTerminate,
} from './shared';

/**
 * Step 1 of 2 — create (or adopt) the Clover order.
 *
 * Architecture (Option A): the edge pre-builds the exact Clover order body
 * (`buildCloverInjectionPayload`) and freezes it under `jobPayload.order_body`
 * (incl. `externalReferenceId`). This handler POSTs it, but first does a
 * header-independent dedup/resume: looks up an existing Clover order by
 * `externalReferenceId` and adopts it (so a retry whose first attempt succeeded
 * but lost the response does not create a duplicate order). Items follow in
 * step 2 (`reconcile_items`).
 */
registerHandler('clover', 'create_order', async ({ jobPayload, job, step }) => {
  const orderBody = jobPayload['order_body'] as Record<string, unknown> | undefined;
  const externalRef = jobPayload['external_reference_id'] as string | undefined;
  const orderId = jobPayload['order_id'];
  if (!orderBody || typeof orderBody !== 'object') {
    throw new HandlerError('Clover injection payload missing `order_body`', 'MISSING_ORDER_BODY', false);
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const client = createCloverClient(CloverConfigSchema.parse(config), job.correlation_id, job.site_id);

  // Primary, header/filter-independent dedup: if this MCM order already has a
  // Clover ticket persisted (from a prior attempt), adopt it. Reliable even if
  // the Clover `externalReferenceId` filter syntax differs.
  const state = await getOrderCloverState(job.site_id, orderId);
  if (state?.clover_ticket_id) {
    return { clover_order_id: state.clover_ticket_id, adopted: true };
  }

  if (externalRef) {
    try {
      const existingId = await findCloverOrderIdByExternalRef(client, externalRef);
      if (existingId) {
        await persistCloverTicketId(job.site_id, orderId, existingId);
        return { clover_order_id: existingId, adopted: true };
      }
    } catch {
      // best-effort lookup; fall through to create
    }
  }

  try {
    const res = await client.post<{ id: string }>('/orders', orderBody);
    const cloverOrderId = res.data?.id;
    if (!cloverOrderId) {
      throw new HandlerError('Clover create order response missing id', 'MISSING_ORDER_ID', false, res.status, res.data);
    }
    await persistCloverTicketId(job.site_id, orderId, cloverOrderId);
    return { clover_order_id: cloverOrderId };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapCloverError(err, 'CLOVER_CREATE_ORDER_FAILED');
    if (willTerminate(he.retryable, step)) {
      await persistInjectionError(job.site_id, orderId, he);
    }
    throw he;
  }
});
