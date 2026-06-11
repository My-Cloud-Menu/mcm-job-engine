import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapOmnivoreError } from '../error-map';
import { syncOmnivoreInventory } from './inventory/sync-inventory';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/**
 * Recurring + on-demand Omnivore → MCM INVENTORY/MENU sync: categories, products,
 * price levels, modifiers (ingredients) and modifier groups. Ported from the legacy
 * `syncOmnivoreProductsV2` + `syncOmnivoreIngredientsAndGroupsV2` (Supabase path).
 * Scheduled via sync_schedules (sync_type='fetch_products', 24h) or on-demand via
 * trigger_sync_now. Idempotent; additive (no deletes of products/ingredients/groups).
 */
registerHandler('omnivore', 'fetch_products', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);
  const priceLevelPreferences =
    ((config as Record<string, unknown>).priceLevelPreferences as Record<string, string>) ?? {};

  const started = Date.now();
  let result;
  try {
    result = await syncOmnivoreInventory({
      site_id: job.site_id,
      client,
      set_available_to_buy: true, // imported products → published
      only_include_prices_and_stock_changes: false,
      price_level_preferences: priceLevelPreferences,
    });
  } catch (err) {
    throw mapOmnivoreError(err, 'OMNIVORE_FETCH_PRODUCTS_FAILED');
  }
  const duration = Date.now() - started;

  await supabase.from('omnivore_inventory_sync_log').insert({
    site_id: job.site_id,
    location_id: omnivoreConfig.omnivoreId,
    source: isManual ? 'manual' : 'scheduled',
    duration_ms: duration,
    categories_created: result.categories.created,
    products_created: result.products.created,
    products_updated: result.products.updated,
    price_levels_created: result.price_levels.created,
    price_levels_updated: result.price_levels.updated,
    price_levels_deleted: result.price_levels.deleted,
    ingredients_created: result.ingredients.created,
    ingredients_updated: result.ingredients.updated,
    groups_created: result.groups.created,
    groups_updated: result.groups.updated,
    status: 'ok',
  });

  logger.info({ site_id: job.site_id, duration_ms: duration, ...result }, 'omnivore fetch_products completed');

  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }

  return result as unknown as Record<string, unknown>;
});
