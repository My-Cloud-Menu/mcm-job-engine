import { AxiosInstance } from 'axios';
import { supabase } from '../../../lib/supabase';

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
 *   - is_active: Omnivore exposes NO per-employee active flag, so we don't manage it —
 *     `is_active` is omitted from the payload → DB default `true` on insert, preserved on
 *     update (a manual deactivation in MCM is never clobbered). Absent employees are not
 *     deactivated (the "deactivate-missing" reconcile was not selected).
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
  do {
    const res: { data: any } = nextUrl ? await client.get(nextUrl) : await client.get('/employees');
    const page = res.data?._embedded?.employees;
    if (Array.isArray(page)) items.push(...page);
    nextUrl = res.data?._links?.next?.href ?? null;
    if (nextUrl) await sleep(PAGE_DELAY_MS);
  } while (nextUrl);
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
    .select('login, first_name, last_name, pos_id, check_name, role')
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
      // is_active intentionally omitted (see file header).
    };

    if (!prev) {
      created++;
      toWrite.push(row);
      continue;
    }
    const changed =
      (prev.first_name ?? '') !== row.first_name ||
      (prev.last_name ?? '') !== row.last_name ||
      (prev.pos_id ?? '') !== row.pos_id ||
      (prev.check_name ?? '') !== row.check_name ||
      (prev.role ?? '') !== row.role;
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

  return { total: employees.length, created, updated };
}
