import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapOmnivoreError } from '../error-map';
import { fetchOmnivoreTables, fetchOmnivoreRevenueCenters } from './table-mapper';

// schedule_id is nullable: a manual "sync now" can run before the 24h schedule
// row exists (toggle off). When present, we close the schedule cycle.
const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/**
 * Recurring + on-demand Omnivore → MCM sync of TABLES and REVENUE CENTERS into the
 * floor module. Fetches the full lists (paginated, atomic), then hands them to the
 * transactional reconcile RPC `sync_omnivore_floor_tables` (adoption-by-number,
 * layout preservation, soft-archive with safeguards, active-order protection).
 * Scheduled via `sync_schedules` (integration='omnivore', sync_type='fetch_tables',
 * 86400s) or triggered on-demand via `trigger_sync_now`.
 */
registerHandler('omnivore', 'fetch_tables', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);

  let tables;
  let revenueCenters;
  try {
    // F24: solo el fetch de MESAS es fatal (un list parcial de mesas NO debe llegar al reconcile que archivaría
    // mesas ausentes — atomicidad intencional). Los revenue-centers son COSMÉTICOS (el RPC hace COALESCE a '[]'
    // y cae al nombre embebido en cada mesa / 'Omnivore') → un blip de /revenue_centers NO debe abortar el sync.
    [tables, revenueCenters] = await Promise.all([
      fetchOmnivoreTables(client),
      fetchOmnivoreRevenueCenters(client).catch((err) => {
        logger.warn(
          { site_id: job.site_id, err: String((err as any)?.message ?? err) },
          'omnivore revenue_centers fetch failed; falling back to [] (table sync continues)'
        );
        return [];
      }),
    ]);
  } catch (err) {
    throw mapOmnivoreError(err, 'OMNIVORE_FETCH_TABLES_FAILED');
  }

  const { data, error } = await supabase.rpc('sync_omnivore_floor_tables', {
    p_site_id: job.site_id,
    p_location_id: omnivoreConfig.omnivoreId,
    p_tables: tables,
    p_revenue_centers: revenueCenters,
    p_source: isManual ? 'manual' : 'scheduled',
  });
  if (error) throw new Error(`sync_omnivore_floor_tables failed: ${error.message}`);

  logger.info(
    { site_id: job.site_id, tables: tables.length, revenue_centers: revenueCenters.length, ...data },
    'omnivore fetch_tables completed'
  );

  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', {
      p_schedule_id: input.schedule_id,
      p_cursor: null,
    });
  }

  return (data ?? {}) as Record<string, unknown>;
});
