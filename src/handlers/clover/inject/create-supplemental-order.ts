import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { mapCloverError } from '../error-map';
import { findCloverOrderIdByExternalRef, persistInjectionError, willTerminate } from './shared';
import { readManifest, persistSupplementCloverId } from './supplemental';

/**
 * Step 1 of 2 — create (or adopt) a SUPPLEMENTAL Clover order for items added
 * after the primary order was paid. Unlike the primary `create_order`, this:
 *   - persists the Clover id into the manifest entry (NOT `orders.clover_ticket_id`,
 *     which belongs to the primary);
 *   - adopts by manifest `delta_signature` first (header-independent), then by
 *     `externalReferenceId`, before POSTing — so retries never duplicate.
 * Step 2 reuses the standard `reconcile_items` handler (with `supplemental:true`).
 */
registerHandler('clover', 'create_supplemental_order', async ({ jobPayload, job, step }) => {
  const orderBody = jobPayload['order_body'] as Record<string, unknown> | undefined;
  const externalRef = jobPayload['external_reference_id'] as string | undefined;
  const deltaSig = jobPayload['delta_signature'] as string | undefined;
  const orderId = jobPayload['order_id'];
  const totalCents =
    typeof jobPayload['order_total_cents'] === 'number'
      ? (jobPayload['order_total_cents'] as number)
      : undefined;

  if (!orderBody || typeof orderBody !== 'object') {
    throw new HandlerError('Supplemental injection payload missing `order_body`', 'MISSING_ORDER_BODY', false);
  }
  if (!deltaSig) {
    throw new HandlerError('Supplemental injection payload missing `delta_signature`', 'MISSING_DELTA_SIG', false);
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const client = createCloverClient(CloverConfigSchema.parse(config), job.correlation_id, job.site_id);

  // Primary adopt: manifest already has this supplement's Clover id (prior attempt).
  const manifest = await readManifest(job.site_id, orderId);
  const entry = (manifest.supplements || []).find((s) => s.delta_signature === deltaSig);
  if (entry?.clover_order_id) {
    return { clover_order_id: entry.clover_order_id, adopted: true };
  }

  // Secondary adopt: an existing Clover order by this supplement's externalReferenceId.
  if (externalRef) {
    try {
      const existingId = await findCloverOrderIdByExternalRef(client, externalRef);
      if (existingId) {
        await persistSupplementCloverId(job.site_id, orderId, deltaSig, existingId, totalCents);
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
      throw new HandlerError(
        'Clover create supplemental order response missing id',
        'MISSING_ORDER_ID',
        false,
        res.status,
        res.data
      );
    }
    await persistSupplementCloverId(job.site_id, orderId, deltaSig, cloverOrderId, totalCents);
    return { clover_order_id: cloverOrderId };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapCloverError(err, 'CLOVER_CREATE_SUPPLEMENTAL_FAILED');
    if (willTerminate(he.retryable, step)) {
      await persistInjectionError(job.site_id, orderId, he);
    }
    throw he;
  }
});
