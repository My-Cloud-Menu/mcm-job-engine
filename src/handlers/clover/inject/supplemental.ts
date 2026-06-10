import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { enqueueCloverSupplementalInjection } from '../../../enqueue/helpers';
import { persistCloverHash, persistInjectionError } from './shared';

/**
 * "Supplemental Clover orders" — Clover's REST API cannot reopen or mutate a
 * PAID/locked order (verified: the `state` field is cosmetic, no reopen endpoint,
 * line items can't be added once a payment exists). So when items are added in
 * the source POS (Omnivore→MCM→Clover) AFTER the Clover order was paid, we bill
 * the NEW items on a SECOND ("supplemental") Clover order linked to the same MCM
 * order, instead of silently dropping them.
 *
 * State lives under `orders.additional_properties.clover_supplemental` (jsonb, no
 * migration). The delta (what to put on a new supplement) = the frozen Clover
 * line items not yet billed on the primary + prior supplements.
 */

export interface SupplementEntry {
  external_reference_id: string;
  clover_order_id: string | null;
  delta_signature: string;
  delta_keys: Record<string, number>;
  total_cents: number;
}

export interface SupplementalManifest {
  primary?: { clover_order_id?: string | null; billed_keys?: Record<string, number> };
  supplements?: SupplementEntry[];
}

/**
 * Stable, absorber-independent line key = `name || note`. The reconciliation
 * absorber (buildCloverLineItemsWithTaxes) can shift ONE line's price by a few
 * cents, so price is excluded from the key. `note` encodes the modifiers, so
 * items that differ only by modifier still get distinct keys. This key matches
 * between the frozen Clover payload and Clover-side GET line items (both carry
 * `name` + `note`), which is what lets us seed `billed_keys` for legacy orders.
 */
export function lineKey(li: any): string {
  return `${li?.name ?? ''}||${li?.note ?? ''}`;
}

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) hash = (hash * 33) ^ str.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

/** Supplemental order's own externalReferenceId (≤12 chars, Clover invoice limit). */
export function buildSupplementalExternalRef(siteId: number, orderId: unknown, deltaSig: string): string {
  return ('ms' + djb2(`${siteId}:${orderId}:${deltaSig}`)).slice(0, 12);
}

export function multisetFromLines(lines: any[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const li of lines || []) {
    const k = lineKey(li);
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function lineTotalCents(li: any): number {
  return (
    (li.price || 0) +
    (li.taxRates || []).reduce((a: number, t: any) => a + (t.taxAmount || 0), 0)
  );
}

export function mergedBilledKeys(manifest: SupplementalManifest): Record<string, number> {
  const billed: Record<string, number> = { ...(manifest.primary?.billed_keys || {}) };
  for (const s of manifest.supplements || []) {
    for (const [k, c] of Object.entries(s.delta_keys || {})) {
      billed[k] = (billed[k] || 0) + c;
    }
  }
  return billed;
}

export function deltaSignature(deltaKeys: Record<string, number>): string {
  const sorted = Object.keys(deltaKeys)
    .sort()
    .map((k) => `${k}:${deltaKeys[k]}`)
    .join('|');
  return djb2(sorted);
}

export interface DeltaResult {
  hasRemoval: boolean;
  deltaLines: any[];
  deltaKeys: Record<string, number>;
  totalCents: number;
}

/**
 * Delta = current frozen line items MINUS what's already billed (multiset by
 * `lineKey`). Append-only is the common case. A net removal (a billed key whose
 * current count dropped) flags `hasRemoval` (deferred as a visible needs-review).
 */
export function computeDelta(currentLines: any[], billed: Record<string, number>): DeltaResult {
  const current = multisetFromLines(currentLines);

  let hasRemoval = false;
  for (const k of Object.keys(billed)) {
    if ((current[k] || 0) < billed[k]) {
      hasRemoval = true;
      break;
    }
  }

  const remaining: Record<string, number> = {};
  for (const k of Object.keys(current)) {
    const add = current[k] - (billed[k] || 0);
    if (add > 0) remaining[k] = add;
  }

  const deltaLines: any[] = [];
  const deltaKeys: Record<string, number> = {};
  for (const li of currentLines || []) {
    const k = lineKey(li);
    if (remaining[k] > 0) {
      deltaLines.push(li);
      remaining[k]--;
      deltaKeys[k] = (deltaKeys[k] || 0) + 1;
    }
  }

  const totalCents = deltaLines.reduce((a, li) => a + lineTotalCents(li), 0);
  return { hasRemoval, deltaLines, deltaKeys, totalCents };
}

// ── manifest persistence (read-modify-write, tenant-scoped) ──────────────────

export async function readManifest(siteId: number, orderId: unknown): Promise<SupplementalManifest> {
  const { data } = await supabase
    .from('orders')
    .select('additional_properties')
    .eq('id', orderId)
    .eq('site_id', siteId)
    .maybeSingle();
  const ap = (data?.additional_properties ?? {}) as Record<string, any>;
  return (ap.clover_supplemental ?? {}) as SupplementalManifest;
}

export async function writeManifest(
  siteId: number,
  orderId: unknown,
  manifest: SupplementalManifest
): Promise<void> {
  const { data } = await supabase
    .from('orders')
    .select('additional_properties')
    .eq('id', orderId)
    .eq('site_id', siteId)
    .maybeSingle();
  const ap = {
    ...((data?.additional_properties ?? {}) as Record<string, any>),
    clover_supplemental: manifest,
  };
  const { error } = await supabase
    .from('orders')
    .update({ additional_properties: ap })
    .eq('id', orderId)
    .eq('site_id', siteId);
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover supplemental: failed to write manifest');
  }
}

/** Persist a supplement's Clover order id into its manifest entry (by delta_signature). */
export async function persistSupplementCloverId(
  siteId: number,
  orderId: unknown,
  deltaSig: string,
  cloverOrderId: string
): Promise<void> {
  const manifest = await readManifest(siteId, orderId);
  manifest.supplements = manifest.supplements || [];
  const entry = manifest.supplements.find((s) => s.delta_signature === deltaSig);
  if (entry) {
    entry.clover_order_id = cloverOrderId;
  } else {
    manifest.supplements.push({
      external_reference_id: buildSupplementalExternalRef(siteId, orderId, deltaSig),
      clover_order_id: cloverOrderId,
      delta_signature: deltaSig,
      delta_keys: {},
      total_cents: 0,
    });
  }
  await writeManifest(siteId, orderId, manifest);
}

/**
 * Called by `reconcile_items` when the PRIMARY Clover order is already paid.
 * Replaces the old silent skip: computes the delta and, if there are new items,
 * enqueues a supplemental order job (visible in /admin/jobs). Returns a visible
 * result in every branch (never a silent loss).
 */
export async function handlePaidPrimaryDelta(params: {
  siteId: number;
  orderId: unknown;
  cloverOrderId: string;
  frozenLineItems: any[];
  desiredHash?: string;
  currentCloverLineItems: Array<{ name?: string; note?: string }>;
  correlationId?: string;
}): Promise<Record<string, unknown>> {
  const { siteId, orderId, cloverOrderId, frozenLineItems, desiredHash, currentCloverLineItems } = params;

  const manifest = await readManifest(siteId, orderId);

  // Seed primary.billed_keys for legacy orders (paid before this feature): the
  // Clover primary's CURRENT line items ARE what's already billed.
  if (!manifest.primary?.billed_keys) {
    manifest.primary = {
      clover_order_id: cloverOrderId,
      billed_keys: multisetFromLines(currentCloverLineItems),
    };
  }

  const billed = mergedBilledKeys(manifest);
  const delta = computeDelta(frozenLineItems, billed);

  // Net removal (items removed after the primary was paid) → refund territory on
  // a locked order → VISIBLE needs-review, deferred (not silently lost).
  if (delta.hasRemoval && delta.deltaLines.length === 0) {
    await persistInjectionError(siteId, orderId, {
      code: 'CLOVER_SUPPLEMENTAL_NEGATIVE_DELTA',
      message:
        'Items were removed after the Clover order was paid; a negative supplement cannot be billed (needs a refund).',
    });
    if (desiredHash) await persistCloverHash(siteId, orderId, desiredHash);
    return { needs_review: 'negative_delta' };
  }

  // No new items → nothing to bill; persist the primary hash so the recurring
  // push stops re-triggering this state.
  if (delta.deltaLines.length === 0) {
    if (desiredHash) await persistCloverHash(siteId, orderId, desiredHash);
    return { skipped: 'no_delta_paid' };
  }

  // New items → record the supplement entry (idempotent on delta signature) and
  // enqueue the supplemental order job.
  const sig = deltaSignature(delta.deltaKeys);
  const externalRef = buildSupplementalExternalRef(siteId, orderId, sig);

  manifest.supplements = manifest.supplements || [];
  if (!manifest.supplements.find((s) => s.delta_signature === sig)) {
    manifest.supplements.push({
      external_reference_id: externalRef,
      clover_order_id: null,
      delta_signature: sig,
      delta_keys: delta.deltaKeys,
      total_cents: delta.totalCents,
    });
  }
  await writeManifest(siteId, orderId, manifest);

  const jobId = await enqueueCloverSupplementalInjection({
    siteId,
    orderId: orderId as string | number,
    externalReferenceId: externalRef,
    deltaSignature: sig,
    lineItems: delta.deltaLines,
    totalCents: delta.totalCents,
    correlationId: params.correlationId,
  });

  // Persist the primary hash so the recurring primary push stops re-triggering —
  // the new items now live on the supplement.
  if (desiredHash) await persistCloverHash(siteId, orderId, desiredHash);

  logger.info(
    { site_id: siteId, order_id: orderId, supplemental_job: jobId, delta_items: delta.deltaLines.length },
    'clover reconcile: primary paid → enqueued supplemental order for the added items'
  );
  return { supplemental_enqueued: jobId, delta_items: delta.deltaLines.length };
}
