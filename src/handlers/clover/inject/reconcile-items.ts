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
  const parsedConfig = CloverConfigSchema.parse(config);
  const client = createCloverClient(parsedConfig, job.correlation_id);
  const nativeModifiers = (parsedConfig as any).cloverNativeModifiers === true;

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
      total?: number;
      lineItems?: { elements?: Array<{ id: string; name?: string; note?: string; price?: number }> };
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
        // Objetivo de dinero de la orden y lo que Clover ya tiene facturado en la primaria:
        // con esos dos el suplemento factura EXACTAMENTE lo que falta, sin reconstruir tax.
        orderTotalCents: typeof orderTotalCents === 'number' ? orderTotalCents : null,
        primaryCloverTotalCents: typeof cur.data?.total === 'number' ? cur.data.total : null,
        // Sólo se invoca si hay suplementos previos que descontar.
        fetchCloverOrder: async (id: string) => {
          const r = await client.get<{
            total?: number;
            lineItems?: { elements?: Array<{ name?: string; price?: number }> };
          }>(`/orders/${id}?expand=lineItems`);
          return { total: r.data?.total, lineItems: r.data?.lineItems?.elements || [] };
        },
      });
    }
    // A supplemental order is brand-new → never has payments; it reconciles below.
    for (const li of existing) {
      try {
        await client.delete(`/orders/${cloverOrderId}/line_items/${li.id}`);
      } catch (e) {
        logger.warn({ e, site_id: job.site_id, line_item: li.id }, 'clover reconcile: delete line item failed');
        // With native modifiers on, a SURVIVING old line would duplicate items+modifications on
        // the recreate. Fail (retryable) so the whole reconcile retries cleanly instead of
        // accumulating duplicates. (Legacy non-native path keeps the tolerant swallow.)
        if (nativeModifiers) {
          throw new HandlerError('clover reconcile: delete line item failed (native modifiers on)', 'CLOVER_DELETE_LINE_ITEM_FAILED', true);
        }
      }
    }

    if (lineItems.length > 0) {
      // `modifiers` is our own per-line field (applied natively below), not a Clover
      // bulk_line_items field — strip it so the bulk payload stays clean. No-op for the
      // production edge payload (which has no `modifiers` field).
      const bulkItems = (lineItems as any[]).map((li) => { const { modifiers, ...rest } = li; return rest; });
      // Clover caps bulk_line_items at 100 line items PER REQUEST (a 120-item POST 400s with
      // "maximum ... is 100" and creates NOTHING). Chunk so a large order (big party / catering,
      // up to the 2500/order cap) doesn't fail. bulk returns EITHER a bare array OR {elements:[...]}.
      const BULK_MAX = 100;
      const created: Array<{ id: string; name?: string; price?: number }> = [];
      for (let off = 0; off < bulkItems.length; off += BULK_MAX) {
        const chunk = bulkItems.slice(off, off + BULK_MAX);
        const res = await client.post<any>(`/orders/${cloverOrderId}/bulk_line_items`, { items: chunk });
        const rd: any = res.data;
        const chunkCreated: Array<{ id: string; name?: string; price?: number }> = Array.isArray(rd) ? rd : (rd?.elements ?? []);
        // Clover may return HTTP 200 with an inline `errors` array; treat that as a failure
        // so items don't silently go missing.
        const inlineErrors = Array.isArray(rd) ? undefined : rd?.errors;
        if (Array.isArray(inlineErrors) && inlineErrors.length > 0) {
          throw new HandlerError(
            `Clover bulk_line_items returned ${inlineErrors.length} inline error(s)`,
            'CLOVER_BULK_LINE_ITEMS_ERRORS',
            false,
            res.status,
            res.data
          );
        }
        created.push(...chunkCreated);
      }

      // ADDITIVE, flag-gated (cloverNativeModifiers): attach catalog modifiers to each created
      // line item via POST /line_items/{id}/modifications. Idempotent BY CONSTRUCTION: reconcile
      // DELETE+RECREATEs the whole line-item set every run, so modifications never accumulate
      // across retries (a retry deletes the line items — and their modifications — then re-posts).
      // Each `lineItems[i].modifiers` = [{ modifier: { id }, name, amount }]. Correlate the created
      // line items to the source lines by (name, price) — NOT by index: the bulk_line_items response
      // order is NOT guaranteed to match the input order. Best-effort per modifier (failure logged).
      if (nativeModifiers) {
        let applied = 0;
        let failed = 0;
        let hadRetryableFailure = false;
        const pool = created.map((c) => ({ id: c.id, name: c.name, price: c.price, used: false }));
        for (const li of lineItems as Array<Record<string, any>>) {
          const mods = li?.modifiers as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(mods) || mods.length === 0) continue;
          const match = pool.find((p) => !p.used && String(p.name) === String(li.name) && Number(p.price) === Number(li.price));
          if (!match) { failed += mods.length; logger.warn({ site_id: job.site_id, clover_order_id: cloverOrderId, name: li.name }, 'clover reconcile: no created line matched for modifiers'); continue; }
          match.used = true;
          for (const m of mods) {
            try {
              await client.post(`/orders/${cloverOrderId}/line_items/${match.id}/modifications`, m);
              applied += 1;
            } catch (e) {
              failed += 1;
              const he = e instanceof HandlerError ? e : mapCloverError(e, 'CLOVER_MODIFICATION_FAILED');
              if (he.retryable) hadRetryableFailure = true;
              logger.warn({ e, site_id: job.site_id, clover_order_id: cloverOrderId, line_item: match.id, retryable: he.retryable }, 'clover reconcile: modification post failed');
            }
          }
        }
        if (applied || failed) logger.info({ site_id: job.site_id, clover_order_id: cloverOrderId, modifications_applied: applied, modifications_failed: failed }, 'clover native modifiers applied');
        // A TRANSIENT modification failure must NOT be persisted as fully synced (persistCloverHash
        // below), else the hash short-circuit would never re-attempt it (permanent silent drop).
        // Throw retryable so the whole reconcile re-runs (DELETE+RECREATE + re-apply). Permanent
        // failures (e.g. 400 invalid catalog modifier) are left best-effort (a retry can't fix them).
        if (hadRetryableFailure) {
          throw new HandlerError('clover reconcile: native modification failed (retryable)', 'CLOVER_MODIFICATION_RETRY', true);
        }
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
