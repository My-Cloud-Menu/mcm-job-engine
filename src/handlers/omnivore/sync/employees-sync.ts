import { AxiosInstance } from 'axios';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { omniArchiveIsSafe } from './archive-guard';

/**
 * Omnivore → MCM employee sync. Ported from the edge function `omnivore-employee-sync`
 * (`_shared/helpers/omnivore-helper.ts::getEmployeeFromOmnivore`), with three robustness
 * improvements over the edge:
 *   - HAL pagination (`_links.next`) — the edge read only the first page.
 *   - One batch upsert on the existing unique index `(site_id, login)` instead of N
 *     select-then-insert/update round-trips.
 *   - Optional chaining throughout (tolerant of incomplete Omnivore shapes).
 *
 * Behavior (per product decisions, verified against the live API on T45pdGqc):
 *   - Match key = (site_id, login). login is the employee PIN.
 *   - Role: 'manager' if any pay_rate job id is in config.managerRoleJobId, else 'waiter'.
 *     NEVER downgrades an employee who is already 'admin' in MCM.
 *   - is_active: Omnivore exposes NO per-employee active flag, so upsert omits it →
 *     DB default `true` on insert, preserved on update (a manual deactivation in MCM is
 *     never clobbered). N10: la desactivación de AUSENTES es OPT-IN vía
 *     config.deactivateMissingEmployees (default off), con empty-guard y solo sobre
 *     empleados con omnivore_employee_id no nulo (nunca staff MCM-nativo).
 *   - Additive: never deletes rows.
 */

export interface OmnivoreEmployeeNormalized {
  id: string;
  pos_id: string | null;
  first_name: string | null;
  last_name: string | null;
  check_name: string | null;
  login: string;
  jobIds: string[];
}

const PAGE_DELAY_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Paginated HAL fetch of /employees following `_links.next.href` until exhausted. */
export async function fetchOmnivoreEmployees(client: AxiosInstance): Promise<any[]> {
  const items: any[] = [];
  let nextUrl: string | null = null;
  let pages = 0;
  do {
    const res: { data: any } = nextUrl ? await client.get(nextUrl) : await client.get('/employees');
    const page = res.data?._embedded?.employees;
    if (Array.isArray(page)) items.push(...page);
    nextUrl = res.data?._links?.next?.href ?? null;
    if (nextUrl) await sleep(PAGE_DELAY_MS);
  } while (nextUrl && ++pages < 200); // MAX_PAGES: backstop contra un _links.next malformado/cíclico
  return items;
}

/** Normalize a raw Omnivore employee; returns null for employees with no login/PIN
 * (login is NOT NULL + the unique match key — a blank login would collide). */
function normalizeEmployee(e: any): OmnivoreEmployeeNormalized | null {
  const login = e?.login != null ? String(e.login) : '';
  if (!login) return null;
  const jobIds: string[] = (e?._embedded?.pay_rates ?? [])
    .map((pr: any) => pr?._embedded?.job?.id)
    .filter((x: any) => x != null)
    .map((x: any) => String(x));
  return {
    id: e?.id != null ? String(e.id) : '',
    pos_id: e?.pos_id != null ? String(e.pos_id) : null,
    first_name: e?.first_name ?? null,
    last_name: e?.last_name ?? null,
    check_name: e?.check_name ?? null,
    login,
    jobIds,
  };
}

/** config.managerRoleJobId can be a single id or an array; normalize to a string Set. */
function normalizeManagerJobIds(v: unknown): Set<string> {
  if (v == null) return new Set();
  const arr = Array.isArray(v) ? v : [v];
  return new Set(arr.map((x) => String(x)));
}

export interface SyncEmployeesResult {
  total: number; // Omnivore employees with a login
  created: number;
  updated: number;
  deactivated?: number; // N10: empleados desactivados por estar ausentes del roster (opt-in)
}

export async function syncOmnivoreEmployees(params: {
  site_id: number;
  client: AxiosInstance;
  config: Record<string, unknown>;
}): Promise<SyncEmployeesResult> {
  const { site_id, client, config } = params;

  const raw = await fetchOmnivoreEmployees(client);
  const employees = raw
    .map(normalizeEmployee)
    .filter((e): e is OmnivoreEmployeeNormalized => e !== null);

  // Existing rows for this site → map by login (for admin-protection + change diff).
  const { data: existingRows, error: readErr } = await supabase
    .from('employees')
    .select('login, first_name, last_name, pos_id, check_name, role, omnivore_employee_id, is_active, additional_properties')
    .eq('site_id', site_id);
  if (readErr) throw readErr;
  const existing = new Map<string, any>();
  for (const r of existingRows ?? []) existing.set(String((r as any).login), r);

  const managerJobIds = normalizeManagerJobIds(config.managerRoleJobId);

  const toWrite: Record<string, unknown>[] = [];
  let created = 0;
  let updated = 0;

  for (const e of employees) {
    const prev = existing.get(e.login);
    let role = e.jobIds.some((j) => managerJobIds.has(j)) ? 'manager' : 'waiter';
    if (prev?.role === 'admin') role = 'admin'; // never downgrade an MCM admin

    const row = {
      site_id,
      login: e.login,
      first_name: e.first_name ?? '',
      last_name: e.last_name ?? '',
      pos_id: e.pos_id ?? '',
      check_name: e.check_name ?? '',
      role,
      // F17: Omnivore Employee.id (llave de join para F35/turnos/N10); null si el empleado no trae id.
      omnivore_employee_id: e.id || null,
      // is_active intentionally omitted (see file header) — salvo reactivación N10 (abajo).
    };

    // N10 reactivación: si el empleado estaba AUTO-desactivado (marker omnivore_roster_absent) y VOLVIÓ al roster
    // (está presente en este loop), reactivar su PIN + limpiar el marker. NO toca desactivaciones MANUALES
    // (empleado presente desactivado a mano, sin marker).
    const wasAutoDeactivated = !!(
      prev && prev.is_active === false && prev.additional_properties?.omnivore_roster_absent === true
    );
    if (wasAutoDeactivated) {
      (row as any).is_active = true;
      (row as any).additional_properties = { ...(prev.additional_properties || {}), omnivore_roster_absent: false };
    }

    if (!prev) {
      created++;
      toWrite.push(row);
      continue;
    }
    const changed =
      wasAutoDeactivated ||
      (prev.first_name ?? '') !== row.first_name ||
      (prev.last_name ?? '') !== row.last_name ||
      (prev.pos_id ?? '') !== row.pos_id ||
      (prev.check_name ?? '') !== row.check_name ||
      (prev.role ?? '') !== row.role ||
      (prev.omnivore_employee_id ?? null) !== (row.omnivore_employee_id ?? null);
    if (changed) {
      updated++;
      toWrite.push(row);
    }
  }

  const CHUNK = 500;
  for (let i = 0; i < toWrite.length; i += CHUNK) {
    const chunk = toWrite.slice(i, i + CHUNK);
    const { error } = await supabase.from('employees').upsert(chunk, { onConflict: 'site_id,login' });
    if (error) throw error;
  }

  // N10 · Desactivar (cerrar PIN) empleados ausentes del roster de Omnivore — OPT-IN + empty-guard.
  // Solo empleados importados (omnivore_employee_id != null); NUNCA staff MCM-nativo. Nunca borra; reversible.
  // El empty-guard (employees.length > 0) evita desactivar en masa por un blip/timeout que devuelva [].
  let deactivated = 0;
  // Gap2 · guard de fetch degradado: además del empty-guard (employees.length > 0), si el roster encogió > cap
  // sobre los empleados YA vinculados a Omnivore, es sospechoso (fetch parcial) → NO desactivar (evita el
  // lockout masivo de PINs por un blip). existingOmnivoreCount===0 → nada que desactivar (safe no-op).
  const existingOmnivoreCount = (existingRows ?? []).filter((r: any) => r.omnivore_employee_id != null).length;
  const deactivateEnabled = (config as any)?.deactivateMissingEmployees === true && employees.length > 0;
  const deactivateSafe = existingOmnivoreCount === 0 || omniArchiveIsSafe(employees.length, existingOmnivoreCount);
  if (deactivateEnabled && !deactivateSafe) {
    logger.warn(
      { site_id, fetched: employees.length, managed: existingOmnivoreCount },
      'omnivore employee deactivation SKIPPED: roster parcial/degradado sospechoso (shrink > cap)'
    );
  }
  if (deactivateEnabled && deactivateSafe) {
    const liveLogins = new Set(employees.map((e) => String(e.login)));
    const toDeactivate = (existingRows ?? []).filter(
      (r: any) => r.omnivore_employee_id != null && !liveLogins.has(String(r.login)) && r.is_active !== false,
    );
    for (const r of toDeactivate) {
      const { error } = await supabase
        .from('employees')
        .update({
          is_active: false,
          // Marca la desactivación como AUTOMÁTICA (ausente del roster) para poder re-activar si el empleado
          // vuelve, sin pisar una desactivación MANUAL (que no lleva este marker).
          additional_properties: { ...((r as any).additional_properties || {}), omnivore_roster_absent: true },
        })
        .eq('site_id', site_id)
        .eq('login', (r as any).login);
      if (error) throw error;
      deactivated++;
    }
  }

  return { total: employees.length, created, updated, deactivated };
}
