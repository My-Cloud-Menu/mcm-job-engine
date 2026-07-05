import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { trackEvent } from '../../../observability/posthog';
import { mapCloverError } from '../error-map';
import { fetchAllCloverElements } from './catalog-sync';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/** Map a Clover role to an MCM role. POS ADMIN/MANAGER → 'manager' (never grants MCM 'admin'
 *  from the POS); everything else → 'waiter'. Never downgrades an existing MCM 'admin'. */
function mapRole(cloverRole: string | undefined, prevRole: string | undefined): string {
  if (prevRole === 'admin') return 'admin';
  const r = String(cloverRole ?? '').toUpperCase();
  return r === 'ADMIN' || r === 'MANAGER' ? 'manager' : 'waiter';
}

function splitName(full: string | undefined): { first: string; last: string } {
  const s = String(full ?? '').trim();
  if (!s) return { first: '', last: '' };
  const i = s.indexOf(' ');
  return i < 0 ? { first: s, last: '' } : { first: s.slice(0, i), last: s.slice(i + 1) };
}

/**
 * Recurring + on-demand Clover → MCM EMPLOYEE sync (ADDITIVE). Mirrors the Omnivore employee
 * sync: match key `(site_id, login)` where **login = Clover `unhashedPin`** (the PIN). The
 * Clover employee id is stored in `pos_id`. Role mapped conservatively; an existing MCM 'admin'
 * is never downgraded. Additive: never deletes employees. Gated by `config.sync_employees`.
 *
 * NOTE (verified in the sandbox, P1.4): Clover only returns `unhashedPin` when the merchant
 * enables passcode login AND the token has PIN visibility. Employees WITHOUT a PIN cannot be
 * keyed by (site_id, login) and are counted as `skipped_no_pin` (event
 * `clover_employee_pin_unmatched`), NOT dropped silently.
 */
registerHandler('clover', 'fetch_employees', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const cloverConfig = CloverConfigSchema.parse(config);

  if ((cloverConfig as any).sync_employees !== true) {
    if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    return { skipped_reason: 'sync_employees_disabled' };
  }

  const client = createCloverClient(cloverConfig, job.correlation_id);
  const started = Date.now();

  let created = 0, updated = 0, skippedNoPin = 0, total = 0;
  try {
    const { elements } = await fetchAllCloverElements(client, job.site_id, '/employees');
    total = elements.length;

    // existing rows for admin-protection + change diff
    const { data: existingRows, error: readErr } = await supabase
      .from('employees')
      .select('login, first_name, last_name, pos_id, check_name, role')
      .eq('site_id', job.site_id);
    if (readErr) throw readErr;
    const existing = new Map<string, any>();
    for (const r of existingRows ?? []) existing.set(String((r as any).login), r);

    const toWrite: Record<string, unknown>[] = [];
    for (const e of elements) {
      const login = e.unhashedPin != null && String(e.unhashedPin) !== '' ? String(e.unhashedPin) : '';
      if (!login) { skippedNoPin++; continue; }
      const prev = existing.get(login);
      const { first, last } = splitName(e.name);
      const row = {
        site_id: job.site_id,
        login,
        first_name: first,
        last_name: last,
        pos_id: e.id != null ? String(e.id) : '',
        check_name: e.nickname ?? '',
        role: mapRole(e.role, prev?.role),
      };
      if (!prev) { created++; toWrite.push(row); continue; }
      const changed =
        (prev.first_name ?? '') !== row.first_name || (prev.last_name ?? '') !== row.last_name ||
        (prev.pos_id ?? '') !== row.pos_id || (prev.check_name ?? '') !== row.check_name ||
        (prev.role ?? '') !== row.role;
      if (changed) { updated++; toWrite.push(row); }
    }

    const CHUNK = 500;
    for (let i = 0; i < toWrite.length; i += CHUNK) {
      const { error } = await supabase.from('employees').upsert(toWrite.slice(i, i + CHUNK), { onConflict: 'site_id,login' });
      if (error) throw error;
    }
  } catch (err) {
    throw mapCloverError(err, 'CLOVER_FETCH_EMPLOYEES_FAILED');
  }

  const duration = Date.now() - started;
  const result = { total, created, updated, skipped_no_pin: skippedNoPin, duration_ms: duration };

  try {
    await supabase.from('clover_employee_sync_log').insert({
      site_id: job.site_id, merchant_id: cloverConfig.merchantId,
      source: isManual ? 'manual' : 'scheduled', duration_ms: duration,
      employees_total: total, employees_created: created, employees_updated: updated,
      employees_skipped_no_pin: skippedNoPin, status: 'ok',
    });
  } catch (e) {
    logger.warn({ site_id: job.site_id, err: String((e as Error).message) }, 'clover_employee_sync_log insert skipped');
  }

  if (skippedNoPin > 0) trackEvent('clover_employee_pin_unmatched', { site_id: job.site_id, count: skippedNoPin, total });
  logger.info({ site_id: job.site_id, ...result }, 'clover fetch_employees completed');

  if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  return result as unknown as Record<string, unknown>;
});
