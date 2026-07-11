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

  const started = Date.now();
  let result;
  try {
    const skipCategoryTypesRaw = (config as Record<string, unknown>).skipCategoryTypes;
    const skipCategoryTypes = Array.isArray(skipCategoryTypesRaw)
      ? skipCategoryTypesRaw.filter((x): x is string => typeof x === 'string')
      : []; // N8: default [] = importar TODO (no-break)
    result = await syncOmnivoreInventory({
      site_id: job.site_id,
      client,
      set_available_to_buy: true, // imported products → published
      only_include_prices_and_stock_changes: false,
      archive_removed: (config as Record<string, unknown>).archiveRemoved === true, // F7: soft-archive de productos ausentes del POS
      skip_category_types: skipCategoryTypes,
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

  // F12 · Persistir overrides inválidos detectados (non-fatal, secundario). Upsert por
  // UNIQUE(site_id,conflict_type,entity_omnivore_id): refresca last_seen_at y re-abre (resolved_at=null)
  // sin duplicar. first_seen_at se preserva (no va en el payload).
  const conflicts = (result as unknown as { conflicts?: Array<Record<string, unknown>> }).conflicts ?? [];
  try {
    const nowIso = new Date().toISOString();
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      await supabase.from('omnivore_inventory_sync_conflicts').upsert(
        conflicts.map((c: any) => ({
          site_id: job.site_id,
          conflict_type: c.conflict_type,
          entity_type: c.entity_type,
          entity_omnivore_id: String(c.entity_omnivore_id),
          entity_mcm_id: c.entity_mcm_id != null ? String(c.entity_mcm_id) : null,
          detail: c.detail ?? {},
          last_seen_at: nowIso,
          resolved_at: null,
        })),
        { onConflict: 'site_id,conflict_type,entity_omnivore_id' }
      );
    }
    // LOW auditoría: auto-cerrar (resolved_at) los conflicts OPEN que YA NO se detectan (el operador los resolvió),
    // para que no queden abiertos permanentemente. Non-fatal.
    const detectedKeys = new Set((conflicts as any[]).map((c) => `${c.conflict_type}|${String(c.entity_omnivore_id)}`));
    const { data: openRows } = await supabase
      .from('omnivore_inventory_sync_conflicts')
      .select('id, conflict_type, entity_omnivore_id')
      .eq('site_id', job.site_id)
      .is('resolved_at', null);
    const toResolve = (openRows ?? [])
      .filter((r: any) => !detectedKeys.has(`${r.conflict_type}|${String(r.entity_omnivore_id)}`))
      .map((r: any) => r.id);
    if (toResolve.length > 0) {
      await supabase.from('omnivore_inventory_sync_conflicts').update({ resolved_at: nowIso }).in('id', toResolve);
    }
  } catch (e) {
    logger.warn({ site_id: job.site_id, err: String(e) }, 'omnivore conflicts persist/auto-close failed (non-fatal)');
  }

  logger.info({ site_id: job.site_id, duration_ms: duration, ...result }, 'omnivore fetch_products completed');

  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }

  return result as unknown as Record<string, unknown>;
});
