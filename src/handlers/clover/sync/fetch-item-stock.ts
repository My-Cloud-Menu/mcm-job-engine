import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { trackEvent } from '../../../observability/posthog';
import { mapCloverError } from '../error-map';
import { fetchAllCloverElements, syncCloverItemStock } from './catalog-sync';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/**
 * Lightweight Clover → MCM 86 / out-of-stock sync (ADDITIVE). Reflects each item's `available`
 * flag into `products.stock_status`/`status` (matched by cloverId), without the full menu
 * upsert — so it can run on a SHORT interval (minutes) while `fetch_products` runs daily.
 * Gated by `config.sync_item_stock` (default OFF). Only flips products that changed; never
 * resurrects a soft-archived product. Rate-limited (G1).
 */
registerHandler('clover', 'fetch_item_stock', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const cloverConfig = CloverConfigSchema.parse(config);

  // The flag gates SCHEDULED runs only; a manual "sync now" always runs.
  if ((cloverConfig as any).sync_item_stock !== true && !isManual) {
    if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    return { skipped_reason: 'sync_item_stock_disabled' };
  }

  const client = createCloverClient(cloverConfig, job.correlation_id);
  const started = Date.now();

  let stats;
  try {
    const { elements: items } = await fetchAllCloverElements(client, job.site_id, '/items', 'itemStock', { cursorField: 'id' });
    stats = await syncCloverItemStock(job.site_id, items);
  } catch (err) {
    throw mapCloverError(err, 'CLOVER_FETCH_ITEM_STOCK_FAILED');
  }
  const duration = Date.now() - started;

  trackEvent('clover_catalog_sync_completed', { site_id: job.site_id, type: 'item_stock', item_stock_updated: stats.updated, total: stats.total, duration_ms: duration });
  logger.info({ site_id: job.site_id, ...stats, duration_ms: duration }, 'clover fetch_item_stock completed');

  if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  return { ...stats, duration_ms: duration } as unknown as Record<string, unknown>;
});
