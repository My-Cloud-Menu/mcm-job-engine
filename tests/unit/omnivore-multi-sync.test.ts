/**
 * Syncs multi-sucursal (Misión Omnivore Multisucursal, F3): salud por conexión (K4), agotados por sucursal (C3/C6),
 * catálogo desde la sucursal fuente (C2), guarda de fase 2 y U2. Base en memoria + cliente Omnivore falso.
 * Lo central: un negocio de UNA conexión (todos los vivos) hace exactamente lo de antes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { newMemState, makeMemSupabase, writesTo, hasSiteFilter, MemState } from './helpers/memory-supabase';

const h = vi.hoisted(() => ({
  state: null as unknown as MemState,
  health: {} as Record<string, any>,           // omnivoreId → respuesta de GET / (o Error)
  oos: {} as Record<string, { items: any[]; modifiers: any[] } | Error>,
  gets: [] as string[],
  inventoryCalls: [] as any[],
  emps: {} as Record<string, any[] | Error>,    // omnivoreId → planilla de GET /employees (o Error)
}));

vi.mock('../../src/lib/supabase', () => ({
  get supabase() {
    return makeMemSupabase(h.state);
  },
}));
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/handlers/omnivore/client', () => ({
  OmnivoreConfigSchema: { parse: (c: any) => { if (!c?.apiKey || !c?.omnivoreId) throw new Error('config incompleta'); return c; } },
  createOmnivoreClient: (cfg: any) => ({
    get: async (p: string) => {
      h.gets.push(`${cfg.omnivoreId}${p}`);
      if (p === '/') {
        const r = h.health[cfg.omnivoreId];
        if (r instanceof Error) throw r;
        return { data: r };
      }
      if (p === '/employees') {
        const e = h.emps[cfg.omnivoreId];
        if (e instanceof Error) throw e;
        return { data: { _embedded: { employees: e ?? [] } } };
      }
      const o = h.oos[cfg.omnivoreId];
      if (o instanceof Error) throw o;
      if (p === '/menu/oos/items') return { data: { _embedded: { menu_items: o?.items ?? [] } } };
      if (p === '/menu/oos/modifiers') return { data: { _embedded: { modifiers: o?.modifiers ?? [] } } };
      throw new Error(`GET inesperado ${p}`);
    },
  }),
}));
vi.mock('../../src/handlers/omnivore/sync/inventory/sync-inventory', () => ({
  syncOmnivoreInventory: async (params: any) => {
    h.inventoryCalls.push(params);
    return {
      categories: { created: 0 }, products: { created: 0, updated: 0 },
      price_levels: { created: 0, updated: 0, deleted: 0 }, ingredients: { created: 0, updated: 0 },
      groups: { created: 0, updated: 0 }, conflicts: [],
    };
  },
}));

import { getHandler } from '../../src/handlers/registry';
import '../../src/handlers/load-handlers';
import { invalidateCredentialsCache } from '../../src/lib/credentials';
import { OMNIVORE_OOS_REASON } from '../../src/handlers/omnivore/sync/inventory/location-stock';

const healthy = (id: string) => ({ id, status: 'online', pos_type: 'aloha', agent_version: '1.2', health: { healthy: true, agent: { healthy: true }, system: { healthy: true }, tickets: { status: 'ok', response_time: 120 }, pos: { ordering: { healthy: true } } } });
const run = (type: string, site: number, extra: { stepInput?: any; jobPayload?: any } = {}) =>
  getHandler('omnivore', type)!({
    stepInput: { schedule_id: '00000000-0000-4000-8000-000000000001', ...(extra.stepInput ?? {}) },
    jobPayload: extra.jobPayload ?? {},
    context: {},
    job: { id: 'j', site_id: site, correlation_id: 'c' } as any,
    step: { attempt_count: 0 } as any,
  });

const SINGLE = 1173690;
const MULTI = 71000000;
const seed = (multiInjects = true) => ({
  site_integrations: [
    { id: 'numen', site_id: SINGLE, provider: 'omnivore', type: 'pos', active: true, location_id: null, config: { apiKey: 'k', omnivoreId: 'NUMEN' } },
    { id: 'biz', site_id: MULTI, provider: 'omnivore', type: 'pos', active: true, location_id: null, config: { apiKey: 'k', omnivoreId: '', sendOrderToOmnivoreInStatusChange: multiInjects, statusChangeToTriggerOmnivoreOrder: 'in-kitchen' } },
    { id: 'l1', site_id: MULTI, provider: 'omnivore', type: 'pos', active: true, location_id: 71000001, config: { omnivoreId: 'L1' } },
    { id: 'l2', site_id: MULTI, provider: 'omnivore', type: 'pos', active: true, location_id: 71000002, config: { omnivoreId: 'L2' } },
    { id: 'l3', site_id: MULTI, provider: 'omnivore', type: 'pos', active: true, location_id: 71000003, config: { omnivoreId: 'L3' } },
  ],
  locations: [{ id: 71000002, site_id: MULTI, is_default: true }],
  products: [{ id: 10, site_id: MULTI, additional_properties: { omnivoreId: 'P10' } }, { id: 11, site_id: MULTI, additional_properties: { omnivoreId: 'P11' } }],
  ingredients: [{ id: 20, site_id: MULTI, additional_properties: { omnivoreId: 'M20' } }],
  stock_availability: [],
  sync_schedules: [],
  pos_health: [],
  pos_connection_health: [],
});

beforeEach(() => {
  invalidateCredentialsCache();
  h.state = newMemState(seed());
  h.health = { NUMEN: healthy('NUMEN'), L1: healthy('L1'), L2: healthy('L2'), L3: healthy('L3') };
  h.oos = {};
  h.gets = [];
  h.inventoryCalls = [];
  h.emps = {};
});

describe('fetch_health (K2 + K4)', () => {
  it('una conexión (vivos): la MISMA fila de pos_health de antes + su fila por conexión', async () => {
    const out = await run('fetch_health', SINGLE);
    expect(out).toEqual({ overall_healthy: true });                 // misma salida que antes
    const ph = h.state.tables.pos_health!;
    expect(ph).toHaveLength(1);
    expect(ph[0]).toMatchObject({ site_id: SINGLE, provider: 'omnivore', source: 'scheduled', location_id: 'NUMEN', overall_healthy: true, error: null });
    expect(Object.keys(ph[0]!).sort()).toEqual(['id', 'site_id', 'provider', 'source', 'checked_at', 'updated_at',
      'location_id', 'pos_status', 'pos_type', 'agent_version', 'overall_healthy', 'agent_healthy', 'agent_cpu', 'agent_memory',
      'agent_processes', 'system_healthy', 'system_cpu', 'system_memory', 'tickets_status', 'tickets_response_time',
      'ordering_healthy', 'error'].sort());
    expect(h.state.tables.pos_connection_health).toEqual([expect.objectContaining({ integration_id: 'numen', site_id: SINGLE, location_id: null, pos_location_ref: 'NUMEN', overall_healthy: true })]);
    expect(h.state.tables.sync_schedules).toHaveLength(0);           // no programa agotados
    expect(h.state.rpcs.map((r) => r.name)).toEqual(['complete_sync_schedule']);
  });

  it('una conexión: si falla la tabla nueva, el resultado no cambia', async () => {
    h.state.failOn['pos_connection_health:upsert'] = { message: 'boom' };
    await expect(run('fetch_health', SINGLE)).resolves.toEqual({ overall_healthy: true });
    expect(h.state.tables.pos_health).toHaveLength(1);
  });

  it('varias sucursales: una fila por conexión, resumen del negocio y agotados programados', async () => {
    h.health.L3 = new Error('agent offline');
    const out = await run('fetch_health', MULTI);
    expect(out).toEqual({ overall_healthy: false, connections: 3, unhealthy: 1 });
    const rows = h.state.tables.pos_connection_health!;
    expect(rows.map((r) => [r.integration_id, r.location_id, r.overall_healthy])).toEqual([
      ['l1', 71000001, true], ['l2', 71000002, true], ['l3', 71000003, false],
    ]);
    expect(rows.find((r) => r.integration_id === 'l3')).toMatchObject({ pos_location_ref: 'L3', error: 'agent offline' });
    // Una de tres caída: en línea pero degradado (la tarjeta del inicio lo pinta así), con el texto.
    expect(h.state.tables.pos_health![0]).toMatchObject({ site_id: MULTI, overall_healthy: false, error: '1 de 3 sucursales con problemas', location_id: null, pos_status: 'online', ordering_healthy: false });
    expect(h.state.tables.sync_schedules).toEqual([expect.objectContaining({ site_id: MULTI, integration: 'omnivore', sync_type: 'fetch_stock', interval_seconds: 300, status: 'active' })]);
  });

  it('varias sucursales en línea: sanas aunque Aloha diga que su AGENTE no lo está (misma regla que el dashboard, N13)', async () => {
    for (const k of ['L1', 'L2', 'L3']) h.health[k] = { ...healthy(k), health: { ...healthy(k).health, healthy: false, agent: { healthy: false } } };
    const out = await run('fetch_health', MULTI);
    expect(out).toEqual({ overall_healthy: true, connections: 3, unhealthy: 0 });
    expect(h.state.tables.pos_health![0]).toMatchObject({ site_id: MULTI, overall_healthy: true, error: null, pos_status: 'online', tickets_status: 'functional', ordering_healthy: true });
  });

  it('varias sucursales todas caídas: el negocio fuera de línea', async () => {
    for (const k of ['L1', 'L2', 'L3']) h.health[k] = new Error('agent offline');
    const out = await run('fetch_health', MULTI);
    expect(out).toEqual({ overall_healthy: false, connections: 3, unhealthy: 3 });
    expect(h.state.tables.pos_health![0]).toMatchObject({ pos_status: 'offline', overall_healthy: false, error: '3 de 3 sucursales con problemas' });
  });

  it('varias sucursales que NO inyectan: el sync de agotados se apaga', async () => {
    h.state = newMemState(seed(false));
    h.state.tables.sync_schedules = [{ id: 's', site_id: MULTI, integration: 'omnivore', sync_type: 'fetch_stock', status: 'active' }];
    await run('fetch_health', MULTI);
    expect(h.state.tables.sync_schedules![0]).toMatchObject({ status: 'disabled' });
    const off = writesTo(h.state, 'sync_schedules').find((o) => o.op === 'update')!;
    expect(hasSiteFilter(off, MULTI)).toBe(true);
  });

  it('varias sucursales que NO inyectan pero piden agotados (syncStockAutomatically): el sync de agotados se programa', async () => {
    h.state = newMemState(seed(false));
    h.state.tables.site_integrations!.find((r) => r.id === 'biz')!.config.syncStockAutomatically = true;
    await run('fetch_health', MULTI);
    expect(h.state.tables.sync_schedules).toEqual([expect.objectContaining({ site_id: MULTI, integration: 'omnivore', sync_type: 'fetch_stock', interval_seconds: 300, status: 'active' })]);
  });

  it('U2: una sola conexión → solo esa fila; no toca el resumen', async () => {
    await run('fetch_health', MULTI, { stepInput: { integration_id: '6f1c2b9e-0000-4000-8000-000000000000' } }).catch((e) => e);
    // id que no es del negocio → error sin reintento, nada escrito
    expect(h.state.tables.pos_connection_health).toHaveLength(0);
    h.state.tables.site_integrations!.find((r) => r.id === 'l2')!.id = '6f1c2b9e-0000-4000-8000-000000000002';
    invalidateCredentialsCache();
    await run('fetch_health', MULTI, { stepInput: { integration_id: '6f1c2b9e-0000-4000-8000-000000000002' } });
    expect(h.state.tables.pos_connection_health!.map((r) => r.location_id)).toEqual([71000002]);
    expect(h.state.tables.pos_health).toHaveLength(0);
  });
});

describe('fetch_stock (C3 + C6)', () => {
  it('una conexión: no hace nada (los vivos siguen con products.stock_status)', async () => {
    await expect(run('fetch_stock', SINGLE)).resolves.toEqual({ skipped: 'single_connection' });
    expect(h.gets).toEqual([]);
    expect(writesTo(h.state, 'stock_availability')).toHaveLength(0);
  });

  it('varias: agotados por sucursal; una sucursal caída no frena a las demás', async () => {
    h.oos = { L1: { items: [{ id: 'P10' }, { id: 'ZZZ' }], modifiers: [{ id: 'M20' }] }, L2: new Error('timeout'), L3: { items: [], modifiers: [] } };
    const out: any = await run('fetch_stock', MULTI);
    expect(out.connections).toBe(3);
    expect(out.failed).toBe(1);
    const rows = h.state.tables.stock_availability!;
    expect(rows.map((r) => [r.location_id, r.entity_type, r.entity_id, r.reason])).toEqual([
      [71000001, 'product', 10, OMNIVORE_OOS_REASON], [71000001, 'ingredient', 20, OMNIVORE_OOS_REASON],
    ]);
    for (const r of rows) expect(r.site_id).toBe(MULTI);
    expect(h.state.rpcs.map((r) => r.name)).toEqual(['complete_sync_schedule']);
  });

  it('si fallan todas las sucursales, el job falla (se reintenta)', async () => {
    h.oos = { L1: new Error('x'), L2: new Error('y'), L3: new Error('z') };
    await expect(run('fetch_stock', MULTI)).rejects.toThrow();
    expect(h.state.rpcs).toHaveLength(0);
  });
});

describe('fetch_products (C2) y guarda de fase 2', () => {
  it('una conexión: catálogo como siempre (maneja stock_status)', async () => {
    await run('fetch_products', SINGLE);
    expect(h.inventoryCalls[0]).toMatchObject({ site_id: SINGLE, manage_stock: true });
    expect(h.state.tables.omnivore_inventory_sync_log![0]).toMatchObject({ site_id: SINGLE, location_id: 'NUMEN' });
    expect(h.state.tables.sync_schedules).toHaveLength(0);
  });

  it('varias: catálogo desde la sucursal principal, sin tocar stock_status, y agotados programados', async () => {
    await run('fetch_products', MULTI);
    expect(h.inventoryCalls[0]).toMatchObject({ site_id: MULTI, manage_stock: false });
    expect(h.state.tables.omnivore_inventory_sync_log![0]).toMatchObject({ site_id: MULTI, location_id: 'L2' });
    expect(h.state.tables.sync_schedules![0]).toMatchObject({ sync_type: 'fetch_stock', status: 'active' });
  });

  it('T1: cerrar conflictos lleva site_id', async () => {
    h.state.tables.omnivore_inventory_sync_conflicts = [{ id: 'c1', site_id: SINGLE, conflict_type: 'x', entity_omnivore_id: '1', resolved_at: null }];
    await run('fetch_products', SINGLE);
    const upd = writesTo(h.state, 'omnivore_inventory_sync_conflicts').find((o) => o.op === 'update')!;
    expect(hasSiteFilter(upd, SINGLE)).toBe(true);
  });

  for (const type of ['fetch_open_orders', 'fetch_closed_orders', 'fetch_recent_orders', 'fetch_tables', 'fetch_clock_entries']) {
    it(`${type}: en un negocio multi-sucursal no lee ningún Aloha ni escribe (fase 2)`, async () => {
      await expect(run(type, MULTI)).resolves.toEqual({ skipped: 'multi_location_phase2' });
      expect(h.gets).toEqual([]);
      expect(h.state.ops.filter((o) => o.op !== 'select')).toHaveLength(0);
      expect(h.state.rpcs.map((r) => r.name)).toEqual(['complete_sync_schedule']);
    });
  }

  for (const type of ['fetch_open_orders', 'fetch_closed_orders']) {
    it(`${type}: «sincronizar ahora» en un negocio sin schedules (schedule_id nulo) no muere (OBS #24)`, async () => {
      await expect(run(type, MULTI, { stepInput: { schedule_id: null } })).resolves.toEqual({ skipped: 'multi_location_phase2' });
      expect(h.state.rpcs).toHaveLength(0);
    });
  }
});

describe('fetch_employees con varias sucursales (unión por PIN)', () => {
  const emp = (id: string, login: string, first: string, last: string, jobs: string[] = ['1']) => ({
    id, login, pos_id: id, first_name: first, last_name: last, check_name: first,
    _embedded: { pay_rates: jobs.map((j) => ({ _embedded: { job: { id: j } } })) },
  });
  const withManagerJob = () => {
    h.state.tables.site_integrations!.find((r) => r.id === 'biz')!.config.managerRoleJobId = '10';
    invalidateCredentialsCache();
  };

  it('lee los 3 Alohas, une por PIN y aplica la regla de gerente', async () => {
    withManagerJob();
    h.emps = {
      L1: [emp('a1', '1111', 'Neyda', 'Rodríguez', ['10']), emp('a2', '2251', 'Frances', 'Del Valle', ['10'])],
      L2: [emp('b1', '1111', 'Neyda', 'Rodriguez'), emp('b2', '2251', 'Miguel', 'Carrillo'), emp('b3', '3333', 'Ana', 'Pérez')],
      L3: [emp('c1', '0000', 'GERENTE', 'MGR', ['10'])],
    };
    const out: any = await run('fetch_employees', MULTI);
    expect(out).toMatchObject({ total: 4, created: 4, updated: 0, connections: 3, failed: 0, pin_conflicts: 1, managers: 2 });
    const rows = h.state.tables.employees!;
    const by = (l: string) => rows.find((r) => r.login === l)!;
    // Neyda: misma persona en L1 y L2, gerente en L1; datos de la sucursal principal (71000002 = L2)
    expect(by('1111')).toMatchObject({ site_id: MULTI, role: 'manager', location_ids: [71000001, 71000002], omnivore_employee_id: 'b1' });
    // 2251: personas distintas y solo una es gerente → NO gerente, marcado
    expect(by('2251')).toMatchObject({ role: 'waiter', location_ids: [71000001, 71000002] });
    expect(by('2251').additional_properties).toMatchObject({ omnivore_pin_conflict: true });
    expect(by('3333')).toMatchObject({ role: 'waiter', location_ids: [71000002] });
    expect(by('0000')).toMatchObject({ role: 'manager', location_ids: [71000003] });
    for (const w of writesTo(h.state, 'employees')) {
      expect(w).toMatchObject({ op: 'upsert', onConflict: 'site_id,login' });
      expect((w.payload as any[]).every((r) => r.site_id === MULTI)).toBe(true);
    }
    expect(h.state.tables.omnivore_employee_sync_log).toEqual([expect.objectContaining({ site_id: MULTI, employees_total: 4, status: 'ok' })]);
    // 2.ª corrida igual: nada que escribir
    const again: any = await run('fetch_employees', MULTI);
    expect(again).toMatchObject({ created: 0, updated: 0 });
  });

  it('una sucursal caída: conserva lo que ya se sabía de ella (no le quita la sucursal a nadie)', async () => {
    withManagerJob();
    h.emps = { L1: [emp('a1', '1111', 'Neyda', 'Rodríguez', ['10'])], L2: [emp('b1', '1111', 'Neyda', 'Rodriguez')], L3: [] };
    await run('fetch_employees', MULTI);
    h.emps.L1 = new Error('agent offline');
    const out: any = await run('fetch_employees', MULTI);
    expect(out).toMatchObject({ failed: 1, updated: 0 });
    expect(h.state.tables.employees!.find((r) => r.login === '1111')).toMatchObject({ role: 'manager', location_ids: [71000001, 71000002] });
  });

  it('todas caídas: falla (se reintenta) y no escribe', async () => {
    h.emps = { L1: new Error('agent offline'), L2: new Error('agent offline'), L3: new Error('agent offline') };
    await expect(run('fetch_employees', MULTI)).rejects.toThrow();
    expect(writesTo(h.state, 'employees')).toHaveLength(0);
  });

  it('nunca baja a un admin de MCM', async () => {
    withManagerJob();
    h.state.tables.employees = [{ id: 'x', site_id: MULTI, login: '3333', role: 'admin', location_ids: [], additional_properties: {} }];
    h.emps = { L1: [], L2: [emp('b3', '3333', 'Ana', 'Pérez')], L3: [] };
    await run('fetch_employees', MULTI);
    expect(h.state.tables.employees!.find((r) => r.login === '3333')).toMatchObject({ role: 'admin', location_ids: [71000002] });
  });
});

