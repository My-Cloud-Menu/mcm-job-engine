import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Sync de MESAS Clover → MCM. Las reglas que se prueban aquí no son de adorno: están copiadas de
 * Omnivore porque allí se pagaron caras.
 *
 * El merchant sandbox tiene **0 mesas** y `POST /tables` las rechaza
 * (`Table coordinates are required`), así que no hay forma de probar esto contra Clover real. De
 * ahí que los tests cubran el comportamiento con payloads realistas y que el mapeo sea defensivo.
 */

const h = vi.hoisted(() => ({
  mesasClover: [] as any[], seccionesClover: [] as any[], falloTables: false,
  filas: [] as any[], planes: [] as any[], ordenes: [] as any[],
  inserts: [] as any[], updates: [] as any[],
  cfg: { apiKey: 'k', merchantId: 'M', apiUrl: 'https://x', sync_orders: true, sync_tables: true } as any,
}));

vi.mock('../../src/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/lib/credentials', () => ({ getSiteIntegrationConfig: vi.fn(async () => ({ config: h.cfg })) }));
vi.mock('../../src/handlers/clover/client', async (orig) => {
  const real = await (orig() as any);
  return { ...real, createCloverClient: vi.fn(() => ({
    get: vi.fn(async (u: string) => {
      if (u.includes('/tables/sections')) return { data: { elements: h.seccionesClover } };
      if (u.includes('/tables')) { if (h.falloTables) throw new Error('boom'); return { data: { elements: h.mesasClover } }; }
      return { data: { elements: [] } };
    }),
  })) };
});
vi.mock('../../src/lib/supabase', () => {
  const chain = (rows: any[]) => { const c: any = {
    eq: () => c, in: () => c, range: () => c, order: () => c, contains: () => c, limit: () => c,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    single: async () => ({ data: rows[0] ?? null, error: null }),
    then: (r: any) => r({ data: rows, error: null }) }; return c; };
  const write = () => { const c: any = { eq: () => c, then: (r: any) => r({ error: null }) }; return c; };
  return { supabase: {
    from: (t: string) => ({
      select: () => chain(t === 'floor_elements' ? h.filas : t === 'floor_plans' ? h.planes : t === 'orders' ? h.ordenes : []),
      insert: (row: any) => { h.inserts.push({ t, row });
        return { select: () => ({ single: async () => ({ data: { id: 'PLAN-1' }, error: null }) }), then: (r: any) => r({ error: null }) }; },
      update: (p: any) => { h.updates.push({ t, patch: p }); return write(); },
    }),
    rpc: async () => ({ data: null, error: null }),
  } };
});

import '../../src/handlers/clover/sync/fetch-tables';
import { getHandler } from '../../src/handlers/registry';
import { logger } from '../../src/lib/logger';

const correr = (manual = true) => getHandler('clover', 'fetch_tables')!({
  stepInput: { schedule_id: null, manual }, jobPayload: { manual }, context: {},
  job: { id: 'j', site_id: 99990004, correlation_id: 'c' } as any,
  step: { idempotency_key: 'k', attempt_count: 0, max_attempts: 1 } as any } as any) as Promise<any>;

const mesa = (id: string, nombre: string, extra: any = {}) =>
  ({ id, name: nombre, maxSeats: 4, section: { id: 'S1', name: 'Salón' }, ...extra });
const fila = (extId: string, nombre: string, extra: any = {}) =>
  ({ id: `F-${extId}`, table_name: nombre, table_number: nombre, capacity: 4, section: 'Salón',
     archived_at: null, external_source: 'clover', external_id: extId,
     metadata: { clover_baseline: { table_name: nombre } }, ...extra });

beforeEach(() => {
  h.mesasClover = []; h.seccionesClover = [{ id: 'S1', name: 'Salón' }]; h.falloTables = false;
  h.filas = []; h.planes = [{ id: 'PLAN-1' }]; h.ordenes = [];
  h.inserts = []; h.updates = []; h.cfg = { ...h.cfg, sync_tables: true }; vi.clearAllMocks();
});

describe('sync de mesas de Clover', () => {
  it('una mesa nueva NACE ARCHIVADA (no ensucia el plano existente)', async () => {
    h.mesasClover = [mesa('T1', 'Mesa 1')];
    const r = await correr();
    expect(r.created).toBe(1);
    const ins = h.inserts.find((i) => i.t === 'floor_elements');
    expect(ins.row.archived_at).toBeTruthy();
    expect(ins.row.metadata.archived_reason).toBe('import');
    expect(ins.row.external_source).toBe('clover');
    expect(ins.row.table_name).toBe('Mesa 1');
    expect(ins.row.capacity).toBe(4);
    expect(ins.row.section).toBe('Salón');
  });

  it('EL LAYOUT NUNCA SE TOCA al actualizar', async () => {
    h.filas = [fila('T1', 'Mesa 1', { capacity: 2 })];
    h.mesasClover = [mesa('T1', 'Mesa 1')];               // Clover dice 4 asientos
    await correr();
    const up = h.updates.find((u) => u.t === 'floor_elements');
    expect(up.patch.capacity).toBe(4);
    for (const k of ['x', 'y', 'width', 'height', 'rotation', 'shape', 'z_index']) {
      expect(up.patch).not.toHaveProperty(k);
    }
  });

  it('un nombre editado en MCM sobrevive al sync', async () => {
    h.filas = [fila('T1', 'Terraza VIP', { metadata: { clover_baseline: { table_name: 'Mesa 1' } } })];
    h.mesasClover = [mesa('T1', 'Mesa 1')];
    await correr();
    const up = h.updates.find((u) => u.t === 'floor_elements');
    expect(up.patch.table_name).toBe('Terraza VIP');
    expect(up.patch.metadata.clover_overrides).toEqual(['table_name']);
  });

  it('una mesa que Clover ya no devuelve se ARCHIVA (no se borra)', async () => {
    h.filas = Array.from({ length: 12 }, (_, i) => fila(`T${i}`, `Mesa ${i}`));
    h.mesasClover = Array.from({ length: 11 }, (_, i) => mesa(`T${i}`, `Mesa ${i}`));  // falta T11
    const r = await correr();
    expect(r.archived).toBe(1);
    const arch = h.updates.find((u) => u.patch?.archived_at);
    expect(arch.patch.metadata.archived_reason).toBe('clover_removed');
  });

  it('una mesa CON ORDEN VIVA no se archiva aunque Clover no la devuelva', async () => {
    h.filas = Array.from({ length: 12 }, (_, i) => fila(`T${i}`, `Mesa ${i}`));
    h.mesasClover = Array.from({ length: 11 }, (_, i) => mesa(`T${i}`, `Mesa ${i}`));
    h.ordenes = [{ table_id: 'F-T11' }];                   // la ausente tiene cheque abierto
    const r = await correr();
    expect(r.archived).toBe(0);
  });

  it('el suelo de seguridad bloquea un archivado masivo y deja rastro', async () => {
    h.filas = Array.from({ length: 40 }, (_, i) => fila(`T${i}`, `Mesa ${i}`));
    h.mesasClover = [mesa('T0', 'Mesa 0')];                // Clover devuelve 1 de 40
    const r = await correr();
    expect(r.archived).toBe(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it('si el fetch de mesas falla, complete:false y NO archiva', async () => {
    h.filas = Array.from({ length: 12 }, (_, i) => fila(`T${i}`, `Mesa ${i}`));
    h.falloTables = true;
    const r = await correr();
    expect(r.complete).toBe(false);
    expect(r.archived).toBe(0);
  });

  it('recoge las mesas ANIDADAS dentro de la sección', async () => {
    h.mesasClover = [];
    h.seccionesClover = [{ id: 'S1', name: 'Salón', tables: { elements: [{ id: 'T9', name: 'Mesa 9', maxSeats: 6 }] } }];
    const r = await correr();
    expect(r.created).toBe(1);
    expect(h.inserts.find((i) => i.t === 'floor_elements').row.capacity).toBe(6);
  });

  it('es idempotente: sin cambios no escribe nada', async () => {
    h.filas = [fila('T1', 'Mesa 1')];
    h.mesasClover = [mesa('T1', 'Mesa 1')];
    const r = await correr();
    expect(r.updated).toBe(0);
    expect(r.skipped).toBe(1);
    expect(h.updates).toHaveLength(0);
  });

  it('con `sync_tables` apagada y sin ser manual, no hace nada', async () => {
    h.cfg = { ...h.cfg, sync_tables: false };
    h.mesasClover = [mesa('T1', 'Mesa 1')];
    const r = await correr(false);
    expect(r.skipped_reason).toBe('sync_tables_disabled');
    expect(h.inserts).toHaveLength(0);
  });
});
