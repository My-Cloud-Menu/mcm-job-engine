import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { sanitizeOmnivoreHealth } from './health-mapper';

// schedule_id nullable: un "sync now" manual puede correr antes de que exista la fila de schedule.
const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/**
 * F4/F2 · Poll ÚNICO de salud del POS Omnivore por site (1/site, no N por-viewer). Escribe un snapshot
 * SANITIZADO (sin apiKey) en pos_health; los viewers del dashboard leen esa tabla bajo RLS. Fail-open:
 * si el GET falla, upsert con error + overall_healthy=false (non-fatal, no dead-letterea).
 * Scheduled via sync_schedules (integration='omnivore', sync_type='fetch_health', 120s) o on-demand.
 */
registerHandler('omnivore', 'fetch_health', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);

  let row: Record<string, unknown>;
  try {
    const { data } = await client.get('/'); // baseURL = /1.0/locations/{id}
    row = { ...sanitizeOmnivoreHealth(data), error: null };
  } catch (err: any) {
    row = {
      location_id: omnivoreConfig.omnivoreId, pos_status: null, pos_type: null, agent_version: null,
      overall_healthy: false, agent_healthy: null, agent_cpu: null, agent_memory: null, agent_processes: null,
      system_healthy: null, system_cpu: null, system_memory: null, tickets_status: null, tickets_response_time: null,
      ordering_healthy: null, error: String(err?.message ?? err).slice(0, 500),
    };
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('pos_health').upsert(
    { site_id: job.site_id, provider: 'omnivore', source: isManual ? 'manual' : 'scheduled', checked_at: nowIso, updated_at: nowIso, ...row },
    { onConflict: 'site_id' });
  if (error) throw new Error(`pos_health upsert failed: ${error.message}`);

  logger.info({ site_id: job.site_id, overall_healthy: row.overall_healthy }, 'omnivore fetch_health completed');

  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }
  return { overall_healthy: row.overall_healthy };
});
