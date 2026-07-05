import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { trackEvent } from '../../../observability/posthog';
import { mapCloverError } from '../error-map';
import {
  fetchAllCloverElements,
  syncCloverCategories,
  syncCloverProducts,
  syncCloverItemStock,
  syncCloverPosCatalog,
} from './catalog-sync';
import { syncCloverModifiers } from './modifier-sync';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/**
 * Recurring + on-demand Clover → MCM MENU sync (ADDITIVE, source of truth = Clover).
 * Orchestrates categories → products (category-linked) → item stock/86, all matched by
 * `additional_properties.cloverId`, rate-limited (G1), soft-archive only (G9). Gated per
 * tenant by `config.sync_products` (default OFF). Scheduled via sync_schedules
 * (sync_type='fetch_products') or on-demand via trigger_sync_now. Idempotent.
 */
registerHandler('clover', 'fetch_products', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const cloverConfig = CloverConfigSchema.parse(config);

  const enabled = (cloverConfig as any).sync_products === true;
  if (!enabled) {
    if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    return { skipped_reason: 'sync_products_disabled' };
  }

  const client = createCloverClient(cloverConfig, job.correlation_id);
  const started = Date.now();

  let catStats, prodStats, stockStats, modStats, catalogStats;
  try {
    // 1. categories (needed to link products)
    const cats = await syncCloverCategories(job.site_id, client);
    catStats = cats.stats;
    // 2. items (single expanded fetch feeds products, item-stock and modifier links)
    const { elements: items, complete } = await fetchAllCloverElements(
      client, job.site_id, '/items', 'categories,itemStock,taxRates,modifierGroups', { cursorField: 'id' }
    );
    const prod = await syncCloverProducts(job.site_id, items, complete, cats.cloverIdToMcmId);
    prodStats = prod.stats;
    // 3. item stock / 86 (from the same items payload)
    stockStats = await syncCloverItemStock(job.site_id, items);
    // 4. modifiers / modifier groups → ingredients / ingredients_groups (linked to products)
    modStats = await syncCloverModifiers(job.site_id, client, items, prod.cloverIdToMcmId);
    // 5. (opt-in) maintain a POS catalog so synced products render in /pos-order
    if ((cloverConfig as any).autoManageCloverCatalog === true) {
      const channels = (cloverConfig as any).cloverCatalogChannels || ['pos'];
      catalogStats = await syncCloverPosCatalog(job.site_id, Array.from(cats.cloverIdToMcmId.values()), channels);
    }
  } catch (err) {
    throw mapCloverError(err, 'CLOVER_FETCH_PRODUCTS_FAILED');
  }
  const duration = Date.now() - started;

  const result = {
    categories: catStats,
    products: prodStats,
    item_stock: stockStats,
    modifiers: modStats,
    pos_catalog: catalogStats ?? { skipped: 'autoManageCloverCatalog_off' },
    duration_ms: duration,
  };

  // best-effort sync log (table created in migration 028; non-fatal if absent)
  try {
    await supabase.from('clover_inventory_sync_log').insert({
      site_id: job.site_id,
      merchant_id: cloverConfig.merchantId,
      source: isManual ? 'manual' : 'scheduled',
      duration_ms: duration,
      categories_created: catStats.created, categories_updated: catStats.updated, categories_archived: catStats.archived,
      products_created: prodStats.created, products_updated: prodStats.updated, products_archived: prodStats.archived,
      status: 'ok',
    });
  } catch (e) {
    logger.warn({ site_id: job.site_id, err: String((e as Error).message) }, 'clover_inventory_sync_log insert skipped');
  }

  trackEvent('clover_catalog_sync_completed', {
    site_id: job.site_id, type: 'menu',
    categories_created: catStats.created, categories_updated: catStats.updated, categories_archived: catStats.archived,
    products_created: prodStats.created, products_updated: prodStats.updated, products_archived: prodStats.archived,
    item_stock_updated: stockStats.updated, duration_ms: duration,
  });
  logger.info({ site_id: job.site_id, ...result }, 'clover fetch_products completed');

  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }
  return result as unknown as Record<string, unknown>;
});
