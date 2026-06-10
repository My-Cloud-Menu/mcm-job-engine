import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { logger } from '../../../lib/logger';
import { mapCloverError } from '../error-map';
import { getOrderCloverState, persistCloverHash, persistInjectionError, willTerminate } from './shared';
import { handlePaidPrimaryDelta } from './supplemental';

/**
 * Step 2 of 2 — reconcile the Clover order's line items to the desired state.
 *
 * `jobPayload.line_items` is the exact array the edge built (with robust taxes),
 * and `jobPayload.line_items_hash` is its signature. Strategy = DELETE+RECREATE
 * (the legacy edge approach): fetch current line items, delete them, then
 * bulk-create the frozen desired set. Convergent + idempotent.
 *
 * Guards:
 *  - short-circuit if `orders.clover_line_items_hash` already equals the desired
 *    hash (resume-safe; the idempotency key also includes the hash so a job only
 *    exists for a *new* desired state);
 *  - if the Clover order already has payments → NEEDS_REVIEW (§5.3 #12, never
 *    mutate a paid order);
 *  - >3000 line items → NEEDS_REVIEW (§5.3 #9, Clover hard limit).
 */
registerHandler('clover', 'reconcile_items', async ({ jobPayload, context, job, step }) => {
  const orderId = jobPayload['order_id'];
  // Supplemental jobs name their first step `create_supplemental_order`; the
  // primary uses `create_order`. Resolve the Clover order id from either.
  const isSupplemental = jobPayload['supplemental'] === true;
  const cloverOrderId = ((context['create_order'] ??
    context['create_supplemental_order']) as Record<string, unknown> | undefined)?.[
    'clover_order_id'
  ] as string | undefined;
  if (!cloverOrderId) {
    throw new HandlerError('Missing clover_order_id in context', 'MISSING_CONTEXT', false);
  }

  const lineItems = jobPayload['line_items'];
  const desiredHash = jobPayload['line_items_hash'] as string | undefined;
  // Total autoritativo (centavos) que el edge congeló = Σ(price + taxAmount) de
  // los line items. Clover NO computa `order.total` al agregar items vía
  // bulk_line_items → lo asentamos explícitamente (ver buildCloverInjectionPayload).
  const orderTotalCents = jobPayload['order_total_cents'];
  if (!Array.isArray(lineItems)) {
    throw new HandlerError('Clover injection payload `line_items` missing or not an array', 'MISSING_ITEMS', false);
  }
  if (lineItems.length > 3000) {
    throw new HandlerError(
      `Clover line item limit exceeded (${lineItems.length} > 3000)`,
      'CLOVER_TOO_MANY_LINE_ITEMS',
      false
    );
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const client = createCloverClient(CloverConfigSchema.parse(config), job.correlation_id);

  try {
    // Short-circuit: already synced to this desired state. The order-level
    // `clover_line_items_hash` belongs to the PRIMARY, so skip this for a
    // supplemental job (its own idempotency key already gates re-runs).
    if (desiredHash && !isSupplemental) {
      const state = await getOrderCloverState(job.site_id, orderId);
      if (state?.clover_line_items_hash === desiredHash) {
        return { skipped: 'hash_unchanged' };
      }
    }

    // Fetch current Clover state + payments guard.
    const cur = await client.get<{
      lineItems?: { elements?: Array<{ id: string; name?: string; note?: string }> };
      payments?: { elements?: unknown[] };
    }>(`/orders/${cloverOrderId}?expand=lineItems,payments`);

    const existing = cur.data?.lineItems?.elements || [];

    const hasPayments = (cur.data?.payments?.elements || []).length > 0;
    if (hasPayments && !isSupplemental) {
      // The PRIMARY Clover order is paid → Clover won't let us mutate it. Instead
      // of silently dropping items added after payment (the old behaviour), bill
      // the NEW items on a SUPPLEMENTAL order. handlePaidPrimaryDelta returns a
      // VISIBLE result in every branch (supplemental_enqueued / no_delta_paid /
      // needs_review) — never a silent loss.
      return await handlePaidPrimaryDelta({
        siteId: job.site_id,
        orderId,
        cloverOrderId,
        frozenLineItems: lineItems,
        desiredHash,
        currentCloverLineItems: existing,
        correlationId: job.correlation_id,
      });
    }
    // A supplemental order is brand-new → never has payments; it reconciles below.
    for (const li of existing) {
      try {
        await client.delete(`/orders/${cloverOrderId}/line_items/${li.id}`);
      } catch (e) {
        logger.warn({ e, site_id: job.site_id, line_item: li.id }, 'clover reconcile: delete line item failed');
      }
    }

    if (lineItems.length > 0) {
      const res = await client.post<{ elements?: unknown[]; errors?: unknown[] }>(
        `/orders/${cloverOrderId}/bulk_line_items`,
        { items: lineItems }
      );
      // Clover may return HTTP 200 with an inline `errors` array; treat that as a failure
      // so items don't silently go missing.
      const inlineErrors = (res.data as { errors?: unknown[] } | undefined)?.errors;
      if (Array.isArray(inlineErrors) && inlineErrors.length > 0) {
        throw new HandlerError(
          `Clover bulk_line_items returned ${inlineErrors.length} inline error(s)`,
          'CLOVER_BULK_LINE_ITEMS_ERRORS',
          false,
          res.status,
          res.data
        );
      }
    }

    // Asentar `order.total` DESPUÉS del bulk add (orden importa: el cambio de line
    // items puede dejar el total stale/cero). Cubre create Y ediciones — en una
    // edición create_order adopta la orden sin re-POST, así que este es el único
    // punto que mantiene el total correcto. Partial update: solo toca `total`.
    if (typeof orderTotalCents === 'number' && orderTotalCents > 0) {
      try {
        await client.post(`/orders/${cloverOrderId}`, { total: orderTotalCents });
      } catch (e) {
        // No-fatal: los items ya se reconciliaron; el total es display. Reintenta
        // en el próximo push si cambia el hash.
        logger.warn(
          { e, site_id: job.site_id, order_id: orderId, clover_order_id: cloverOrderId },
          'clover reconcile: failed to set order total (non-fatal)'
        );
      }
    }

    // Persist the synced hash only for the PRIMARY (the order-level column is the
    // primary's; a supplemental job is gated by its own idempotency key instead).
    if (desiredHash && !isSupplemental) {
      await persistCloverHash(job.site_id, orderId, desiredHash);
    }
    return { removed: existing.length, added: lineItems.length };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapCloverError(err, 'CLOVER_RECONCILE_FAILED');
    if (willTerminate(he.retryable, step)) {
      await persistInjectionError(job.site_id, orderId, he);
    }
    throw he;
  }
});
