import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapOmnivoreError } from '../error-map';
import { syncOmnivoreEmployees } from './employees-sync';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/**
 * Recurring + on-demand Omnivore → MCM EMPLOYEE sync. Ported from the edge function
 * `omnivore-employee-sync` (paginated fetch + batch upsert by (site_id, login), role
 * from managerRoleJobId, is_active preserved). Scheduled via sync_schedules
 * (sync_type='fetch_employees', 24h) or on-demand via trigger_sync_now. Idempotent;
 * additive (never deletes employees).
 */
registerHandler('omnivore', 'fetch_employees', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);

  const started = Date.now();
  let result;
  try {
    result = await syncOmnivoreEmployees({
      site_id: job.site_id,
      client,
      config: config as Record<string, unknown>,
    });
  } catch (err) {
    throw mapOmnivoreError(err, 'OMNIVORE_FETCH_EMPLOYEES_FAILED');
  }
  const duration = Date.now() - started;

  await supabase.from('omnivore_employee_sync_log').insert({
    site_id: job.site_id,
    location_id: omnivoreConfig.omnivoreId,
    source: isManual ? 'manual' : 'scheduled',
    duration_ms: duration,
    employees_total: result.total,
    employees_created: result.created,
    employees_updated: result.updated,
    status: 'ok',
  });

  logger.info({ site_id: job.site_id, duration_ms: duration, ...result }, 'omnivore fetch_employees completed');

  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }

  return result as unknown as Record<string, unknown>;
});
