import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { mapOmnivoreError } from '../error-map';
import { HandlerError } from '../../../core/types';
import { ConnectionSet, forEachConnection } from '../connections';
import { fetchOmnivoreEmployees, normalizeEmployee, normalizeManagerJobIds } from './employees-sync';

/**
 * Misión Omnivore Multisucursal · empleados de un negocio con un Aloha por sucursal (pedido de Carlos, Buns 19-oct).
 *
 * MCM guarda UN empleado por PIN y negocio (`employees (site_id, login)`), y `verifyPin` valida solo con negocio + PIN.
 * Cada Aloha tiene su planilla, así que el mismo PIN puede aparecer en varias sucursales:
 *   - la MISMA persona (mismo nombre, sin acentos/mayúsculas; o un apellido que empieza igual) → una fila, con las
 *     sucursales donde trabaja en `location_ids` (el login del POS lo respeta) y gerente si lo es en alguna;
 *   - PERSONAS DISTINTAS con el mismo PIN → una fila (no caben dos) marcada `omnivore_pin_conflict`, y gerente SOLO si
 *     todas lo son: con un PIN compartido, un mesero de otra sucursal no puede firmar como gerente (menor privilegio).
 * Nunca baja a un admin de MCM, nunca borra ni desactiva. El detalle por sucursal queda en
 * `additional_properties.omnivore_locations` (ids del empleado en cada Aloha).
 * Si una sucursal no responde, se usan los datos que ya había de esa sucursal (no se le quita a nadie una sucursal por
 * un corte); si no responde ninguna, falla y se reintenta.
 */

export interface LocationHolder {
  location_id: number;
  employee_id: string | null;
  pos_id: string | null;
  first_name: string;
  last_name: string;
  check_name: string;
  manager: boolean;
}

export interface MergedEmployee {
  login: string;
  holders: LocationHolder[];
  samePerson: boolean;
  manager: boolean;
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Misma persona: mismo nombre y mismo apellido (o uno empieza con el otro: «Rodríguez» / «Rodriguez Mercado»). PURA. */
export function samePerson(a: Pick<LocationHolder, 'first_name' | 'last_name'>, b: Pick<LocationHolder, 'first_name' | 'last_name'>): boolean {
  if (norm(a.first_name) !== norm(b.first_name)) return false;
  const la = norm(a.last_name);
  const lb = norm(b.last_name);
  return la === lb || (la !== '' && lb !== '' && (la.startsWith(lb) || lb.startsWith(la)));
}

/** Une las planillas por PIN. `holders` ordenados por sucursal. PURA. */
export function mergeRosters(holdersByLogin: Map<string, LocationHolder[]>): MergedEmployee[] {
  const out: MergedEmployee[] = [];
  for (const [login, raw] of holdersByLogin) {
    const holders = [...raw].sort((x, y) => x.location_id - y.location_id);
    const same = holders.every((h) => samePerson(h, holders[0]!));
    const manager = same ? holders.some((h) => h.manager) : holders.every((h) => h.manager);
    out.push({ login, holders, samePerson: same, manager });
  }
  return out.sort((a, b) => a.login.localeCompare(b.login));
}

/** Fila de `employees` para un PIN; los datos visibles salen de la sucursal principal si trabaja ahí. PURA. */
export function employeeRow(siteId: number, m: MergedEmployee, prev: any, defaultLocationId: number | null) {
  const main = m.holders.find((h) => h.location_id === defaultLocationId) ?? m.holders[0]!;
  let role = m.manager ? 'manager' : 'waiter';
  if (prev?.role === 'admin') role = 'admin'; // nunca bajar a un admin de MCM
  return {
    site_id: siteId,
    login: m.login,
    first_name: main.first_name,
    last_name: main.last_name,
    pos_id: main.pos_id ?? '',
    check_name: main.check_name,
    role,
    omnivore_employee_id: main.employee_id,
    location_ids: [...new Set(m.holders.map((h) => h.location_id))].sort((a, b) => a - b),
    additional_properties: {
      ...(prev?.additional_properties ?? {}),
      omnivore_locations: m.holders,
      omnivore_pin_conflict: !m.samePerson,
    },
  };
}

const rowChanged = (prev: any, row: ReturnType<typeof employeeRow>) =>
  !prev ||
  (prev.first_name ?? '') !== row.first_name ||
  (prev.last_name ?? '') !== row.last_name ||
  (prev.pos_id ?? '') !== row.pos_id ||
  (prev.check_name ?? '') !== row.check_name ||
  (prev.role ?? '') !== row.role ||
  (prev.omnivore_employee_id ?? null) !== (row.omnivore_employee_id ?? null) ||
  JSON.stringify((prev.location_ids ?? []).map(Number).sort((a: number, b: number) => a - b)) !== JSON.stringify(row.location_ids) ||
  JSON.stringify(prev.additional_properties?.omnivore_locations ?? null) !== JSON.stringify(row.additional_properties.omnivore_locations) ||
  (prev.additional_properties?.omnivore_pin_conflict ?? null) !== row.additional_properties.omnivore_pin_conflict;

export interface SyncEmployeesMultiResult {
  total: number;
  created: number;
  updated: number;
  connections: number;
  failed: number;
  pin_conflicts: number;
  managers: number;
}

export async function syncOmnivoreEmployeesMulti(params: {
  site_id: number;
  set: ConnectionSet;
  defaultLocationId: number | null;
  correlationId: string;
}): Promise<SyncEmployeesMultiResult> {
  const { site_id, set, defaultLocationId, correlationId } = params;

  const results = await forEachConnection(
    set.connections,
    async (conn) => {
      const client = createOmnivoreClient(OmnivoreConfigSchema.parse(conn.config), correlationId);
      const managerJobIds = normalizeManagerJobIds(conn.config['managerRoleJobId']);
      let raw;
      try {
        raw = await fetchOmnivoreEmployees(client);
      } catch (err) {
        throw mapOmnivoreError(err, 'OMNIVORE_FETCH_EMPLOYEES_FAILED');
      }
      return raw
        .map(normalizeEmployee)
        .filter((e): e is NonNullable<ReturnType<typeof normalizeEmployee>> => e !== null)
        .map((e) => ({
          login: e.login,
          holder: {
            location_id: Number(conn.locationId),
            employee_id: e.id || null,
            pos_id: e.pos_id,
            first_name: e.first_name ?? '',
            last_name: e.last_name ?? '',
            check_name: e.check_name ?? '',
            manager: e.jobIds.some((j) => managerJobIds.has(j)),
          } as LocationHolder,
        }));
    },
    { concurrency: 8, timeoutMs: 120_000 }
  );

  const failed = results.filter((r) => !r.ok);
  if (results.length > 0 && failed.length === results.length) {
    const err = (failed[0] as { error: unknown }).error;
    throw err instanceof HandlerError
      ? err
      : new HandlerError(`fetch_employees failed for every connection: ${String((err as Error)?.message ?? err)}`, 'OMNIVORE_FETCH_EMPLOYEES_FAILED', true);
  }
  for (const f of failed) {
    logger.warn({ site_id, location_id: f.connection.locationId, err: String(((f as { error: unknown }).error as Error)?.message ?? (f as { error: unknown }).error) }, 'omnivore fetch_employees: connection failed (se conservan sus datos previos)');
  }

  const { data: existingRows, error: readErr } = await supabase
    .from('employees')
    .select('login, first_name, last_name, pos_id, check_name, role, omnivore_employee_id, is_active, location_ids, additional_properties')
    .eq('site_id', site_id);
  if (readErr) throw readErr;
  const existing = new Map<string, any>();
  for (const r of existingRows ?? []) existing.set(String((r as any).login), r);

  const holdersByLogin = new Map<string, LocationHolder[]>();
  const add = (login: string, h: LocationHolder) => {
    const list = holdersByLogin.get(login) ?? [];
    if (!list.some((x) => x.location_id === h.location_id)) list.push(h);
    holdersByLogin.set(login, list);
  };
  for (const r of results) if (r.ok) for (const { login, holder } of r.value) add(login, holder);
  // Sucursal que no respondió: lo que ya sabíamos de ella se queda.
  const failedLocations = new Set(failed.map((f) => Number(f.connection.locationId)));
  if (failedLocations.size > 0) {
    for (const [login, prev] of existing) {
      for (const h of (prev.additional_properties?.omnivore_locations ?? []) as LocationHolder[]) {
        if (failedLocations.has(Number(h.location_id))) add(login, h);
      }
    }
  }

  const merged = mergeRosters(holdersByLogin);
  const toWrite: Record<string, unknown>[] = [];
  let created = 0;
  let updated = 0;
  for (const m of merged) {
    const prev = existing.get(m.login);
    const row = employeeRow(site_id, m, prev, defaultLocationId);
    if (!prev) {
      created++;
      toWrite.push(row);
    } else if (rowChanged(prev, row)) {
      updated++;
      toWrite.push(row);
    }
  }
  const CHUNK = 500;
  for (let i = 0; i < toWrite.length; i += CHUNK) {
    const { error } = await supabase.from('employees').upsert(toWrite.slice(i, i + CHUNK), { onConflict: 'site_id,login' });
    if (error) throw error;
  }

  return {
    total: merged.length,
    created,
    updated,
    connections: results.length,
    failed: failed.length,
    pin_conflicts: merged.filter((m) => !m.samePerson).length,
    managers: merged.filter((m) => m.manager).length,
  };
}
