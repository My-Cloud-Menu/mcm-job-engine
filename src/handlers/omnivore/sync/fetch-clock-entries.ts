import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapOmnivoreError } from '../error-map';
import { syncOmnivoreClockEntries } from './clock-entries-sync';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/**
 * N11/F20 · Recurring + on-demand Omnivore → MCM CLOCK-ENTRIES (turnos) sync. Espejo del patrón de
 * fetch-employees.ts. Reemplaza el webhook n8n sin site_id (fuga cross-tenant). Scheduled via sync_schedules
 * (sync_type='fetch_clock_entries', 3600s, opt-in syncClockEntriesAutomatically) o on-demand via trigger_sync_now.
 * Idempotente (upsert por site_id,clock_entry_id). Tips CRUDOS (unidad no confirmada → el tab no muestra $).
 */
registerHandler('omnivore', 'fetch_clock_entries', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);

  const started = Date.now();
  let result;
  try {
    result = await syncOmnivoreClockEntries({
      site_id: job.site_id,
      client,
      config: config as Record<string, unknown>,
      source: isManual ? 'manual' : 'scheduled',
    });
  } catch (err) {
    throw mapOmnivoreError(err, 'OMNIVORE_FETCH_CLOCK_ENTRIES_FAILED');
  }
  const duration = Date.now() - started;

  logger.info({ site_id: job.site_id, duration_ms: duration, ...result }, 'omnivore fetch_clock_entries completed');

  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }

  return result as unknown as Record<string, unknown>;
});
