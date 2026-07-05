import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapCloverError } from '../error-map';
import { fetchCloverPayments } from './payment-mapper';
import { upsertCloverPayments } from './upsert-payments';

const InputSchema = z.object({
  schedule_id: z.string().uuid(),
  cursor: z.string().nullable().optional(),
});

// Re-query a small margin behind the watermark to avoid losing rows to
// modifiedTime ties / clock skew; the map dedup absorbs the overlap.
const OVERLAP_MS = 2 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Recurring Clover → MCM payment pull (replaces `clover-payment-notification`).
 * Polls `GET /payments?filter=modifiedTime>=watermark` so voids/refunds that
 * update `modifiedTime` later are re-seen and reflected. Watermark lives in
 * `sync_schedules.last_cursor` (modifiedTime in ms). Leader election + the
 * transactional cursor advance prevent double processing.
 */
registerHandler('clover', 'fetch_payments', async ({ stepInput, job }) => {
  const input = InputSchema.parse(stepInput);

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const client = createCloverClient(CloverConfigSchema.parse(config), job.correlation_id);

  const watermark = input.cursor ? Number(input.cursor) : Date.now() - DEFAULT_LOOKBACK_MS;
  const sinceMs = Math.max(0, watermark - OVERLAP_MS);

  let payments: any[];
  try {
    payments = await fetchCloverPayments(client, sinceMs);
  } catch (err) {
    throw mapCloverError(err, 'CLOVER_PAYMENT_PULL_FAILED');
  }

  const { created, updated, skipped, maxModifiedTime, oldestDeferred } = await upsertCloverPayments(job.site_id, payments);

  // WS-12/F9b: nunca avanzar el watermark más allá del pago más viejo cuya orden aún
  // no existe en MCM, para no perderlo cuando la orden tarda > OVERLAP_MS en aparecer.
  // Bound de 1h: un pago diferido más viejo (orden que nunca sincronizó = orphan a
  // revisar aparte) no atasca el cursor indefinidamente.
  const DEFER_PROTECT_MS = 60 * 60 * 1000;
  let advanced = maxModifiedTime > watermark ? maxModifiedTime : watermark;
  if (oldestDeferred !== null && Date.now() - oldestDeferred < DEFER_PROTECT_MS) {
    advanced = Math.min(advanced, oldestDeferred - 1);
  }
  // clover-bidi (ADDITIVE, G7): never advance the monotonic cursor past now()+skew — a corrupt
  // far-future modifiedTime in the feed would otherwise poison the watermark and permanently
  // skip real rows behind it. Purely defensive (clamps only absurd future timestamps).
  const SKEW_MS = 5 * 60 * 1000;
  advanced = Math.min(advanced, Date.now() + SKEW_MS);
  const newCursor = String(Math.max(0, advanced));

  logger.info(
    { site_id: job.site_id, fetched: payments.length, created, updated, skipped, cursor: newCursor },
    'clover fetch_payments completed'
  );

  await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: newCursor });

  return { fetched: payments.length, created, updated, skipped, cursor: newCursor };
});
