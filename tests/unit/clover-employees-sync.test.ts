import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Sync de EMPLEADOS Clover → MCM. Este handler no tenía ni un test, y desactiva PINes: si se
 * equivoca, el negocio no puede cobrar.
 *
 * El flag `complete` de la paginación NO sirve aquí — `/employees` va en modo OFFSET y ese modo
 * devuelve `complete:true` en cuanto una página trae menos de 100, así que un listado degradado se
 * lee como barrido completo. El cap de merma es la defensa entera.
 */

const h = vi.hoisted(() => ({
  empleadosClover: [] as any[],
  filas: [] as any[],
  updates: [] as any[],
  upserts: [] as any[],
  alertas: [] as any[],
  cfg: { apiKey: 'k', merchantId: 'M', apiUrl: 'https://x', sync_employees: true,
         cloverDeactivateRemovedEmployees: true } as any,
}));

vi.mock('../../src/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/observability/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/observability/alerts', () => ({ enqueueAlert: vi.fn(async (a: any) => { h.alertas.push(a); }) }));
vi.mock('../../src/lib/credentials', () => ({ getSiteIntegrationConfig: vi.fn(async () => ({ config: h.cfg })) }));
vi.mock('../../src/handlers/clover/sync/catalog-sync', () => ({
  fetchAllCloverElements: vi.fn(async () => ({ elements: h.empleadosClover, complete: true })),
}));
vi.mock('../../src/handlers/clover/client', () => ({
  createCloverClient: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
  CloverConfigSchema: { parse: (c: unknown) => c },
}));
vi.mock('../../src/lib/supabase', () => {
  const chain = (rows: any[]) => { const c: any = {
    eq: () => c, order: () => c, limit: () => c,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (r: any) => r({ data: rows, error: null }) }; return c; };
  const write = (t: string, patch: any) => { const c: any = {
    eq: (_col: string, val: any) => { const last = h.updates[h.updates.length - 1]; if (last && last.t === t) last.keys.push(val); return c; },
    then: (r: any) => r({ error: null }) }; return c; };
  return { supabase: {
    from: (t: string) => ({
      select: () => chain(t === 'employees' ? h.filas : []),
      update: (p: any) => { h.updates.push({ t, patch: p, keys: [] as any[] }); return write(t, p); },
      upsert: (rows: any) => { h.upserts.push(rows); return { then: (r: any) => r({ error: null }) }; },
      insert: () => ({ then: (r: any) => r({ error: null }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  } };
});

import '../../src/handlers/clover/sync/fetch-employees';
import { bajasSonSeguras } from '../../src/handlers/clover/sync/fetch-employees';
import { getHandler } from '../../src/handlers/registry';

const correr = () => getHandler('clover', 'fetch_employees')!({
  stepInput: { schedule_id: null, manual: true }, jobPayload: { manual: true }, context: {},
  job: { id: 'j', site_id: 99990004, correlation_id: 'c' } as any,
  step: { idempotency_key: 'k', attempt_count: 0, max_attempts: 1 } as any } as any) as Promise<any>;

/** empleado tal y como lo devuelve Clover */
const emp = (id: string, pin: string, nombre = 'Ana Pérez', extra: any = {}) =>
  ({ id, unhashedPin: pin, name: nombre, role: 'EMPLOYEE', nickname: '', ...extra });
/** fila de MCM ya vinculada a Clover */
const fila = (posId: string, login: string, extra: any = {}) =>
  ({ login, first_name: 'Ana', last_name: 'Pérez', pos_id: posId, check_name: '', role: 'waiter',
     is_active: true, additional_properties: null, ...extra });

const bajados = () => h.updates.filter((u) => u.patch.is_active === false);
const subidos  = () => h.updates.filter((u) => u.patch.is_active === true);

beforeEach(() => {
  h.empleadosClover = []; h.filas = []; h.updates = []; h.upserts = []; h.alertas = [];
  h.cfg = { ...h.cfg, sync_employees: true, cloverDeactivateRemovedEmployees: true };
  vi.clearAllMocks();
});

describe('el suelo anti-wipe', () => {
  it('la fórmula: suelo absoluto 2, no el 10 del catálogo', () => {
    expect(bajasSonSeguras(5, 7, 2)).toBe(true);    // 2 bajas de 7 → pasa
    expect(bajasSonSeguras(4, 7, 3)).toBe(false);   // 3 de 7 (43%) → bloquea
    expect(bajasSonSeguras(10, 20, 3)).toBe(true);  // 15% de 20 = 3
    expect(bajasSonSeguras(10, 20, 10)).toBe(false); // media plantilla → NUNCA
    expect(bajasSonSeguras(140, 165, 24)).toBe(true);
    expect(bajasSonSeguras(1, 7, 6)).toBe(false);   // fetch degradado
    expect(bajasSonSeguras(0, 7, 7)).toBe(false);   // listado vacío
  });

  it('un listado degradado NO desactiva a nadie, y AVISA', async () => {
    // 8 empleados en MCM, Clover devuelve 1: el 200 corto se lee como completo en modo offset
    h.filas = Array.from({ length: 8 }, (_, i) => fila(`C${i}`, `100${i}`));
    h.empleadosClover = [emp('C0', '1000')];
    const r = await correr();
    expect(bajados()).toHaveLength(0);
    expect(r.deactivated).toBe(0);
    expect(r.deactivation_skipped).toMatch(/merma sospechosa/);
    expect(h.alertas).toHaveLength(1);
    expect(h.alertas[0].severity).toBe('warning');
  });

  it('una baja normal sí se aplica, con su marcador', async () => {
    h.filas = [fila('C0', '1000'), fila('C1', '1001'), fila('C2', '1002')];
    h.empleadosClover = [emp('C0', '1000'), emp('C1', '1001')];
    const r = await correr();
    expect(r.deactivated).toBe(1);
    expect(bajados()[0].patch.additional_properties.clover_roster_absent).toBe(true);
    expect(h.alertas).toHaveLength(0);
  });
});

describe('el PIN rotado ya no deja una fila viva con el PIN antiguo', () => {
  it('Clover cambia el pin: la fila vieja se desactiva aunque su pos_id siga vivo', async () => {
    h.filas = [fila('C0', '1000'), fila('C1', '1001'), fila('C2', '1002')];
    h.empleadosClover = [emp('C0', '9999'), emp('C1', '1001'), emp('C2', '1002')]; // C0 rotó su PIN
    const r = await correr();
    // la fila con el PIN viejo cae por el camino normal, sin rama especial
    expect(r.deactivated).toBe(1);
    expect(bajados()[0].keys).toContain('1000');
  });
});

describe('recontratado y baja manual', () => {
  it('reactiva a quien desactivó ESTE sync', async () => {
    h.filas = [fila('C0', '1000', { is_active: false, additional_properties: { clover_roster_absent: true } })];
    h.empleadosClover = [emp('C0', '1000')];
    const r = await correr();
    expect(r.reactivated).toBe(1);
    expect(subidos()[0].patch.additional_properties.clover_roster_absent).toBe(false);
  });

  it('NO pisa una baja hecha a mano (sin marcador)', async () => {
    h.filas = [fila('C0', '1000', { is_active: false, additional_properties: null })];
    h.empleadosClover = [emp('C0', '1000')];
    const r = await correr();
    expect(r.reactivated).toBe(0);
    expect(subidos()).toHaveLength(0);
  });

  it('`is_active` NUNCA viaja en el lote del upsert (rompería el lote entero por NOT NULL)', async () => {
    h.filas = [
      fila('C0', '1000', { is_active: false, additional_properties: { clover_roster_absent: true } }),
      fila('C1', '1001', { first_name: 'OTRO' }),   // fuerza un update normal en el mismo lote
    ];
    h.empleadosClover = [emp('C0', '1000'), emp('C1', '1001')];
    await correr();
    for (const lote of h.upserts) {
      for (const row of lote) {
        expect(Object.keys(row)).not.toContain('is_active');
        expect(Object.keys(row)).not.toContain('additional_properties');
      }
    }
  });
});

describe('soft-deletes de Clover', () => {
  it('un empleado con `deleted:true` NO cuenta como vivo', async () => {
    h.filas = [fila('C0', '1000'), fila('C1', '1001'), fila('C2', '1002')];
    h.empleadosClover = [emp('C0', '1000'), emp('C1', '1001'), emp('C2', '1002', 'Ana', { deleted: true })];
    const r = await correr();
    expect(r.deleted_filtered).toBe(1);
    expect(r.deactivated).toBe(1);        // sin el filtro esto sería 0: no-op silencioso
    expect(bajados()[0].keys).toContain('1002');
  });
});

describe('idempotencia', () => {
  it('una segunda pasada no desactiva a nadie más', async () => {
    h.filas = [fila('C0', '1000'), fila('C1', '1001'),
               fila('C2', '1002', { is_active: false, additional_properties: { clover_roster_absent: true } })];
    h.empleadosClover = [emp('C0', '1000'), emp('C1', '1001')];
    const r = await correr();
    expect(r.deactivated).toBe(0);
    expect(r.reactivated).toBe(0);
  });

  it('con la bandera apagada no se toca a nadie', async () => {
    h.cfg = { ...h.cfg, cloverDeactivateRemovedEmployees: false };
    h.filas = [fila('C0', '1000'), fila('C1', '1001')];
    h.empleadosClover = [emp('C0', '1000')];
    const r = await correr();
    expect(r.deactivated).toBe(0);
    expect(bajados()).toHaveLength(0);
  });

  it('los empleados NATIVOS de MCM (sin pos_id) nunca se tocan', async () => {
    h.filas = [fila('C0', '1000'), fila('', '5555'), fila('', '6666')];
    h.empleadosClover = [emp('C0', '1000')];
    const r = await correr();
    expect(r.deactivated).toBe(0);
    expect(bajados()).toHaveLength(0);
  });
});
