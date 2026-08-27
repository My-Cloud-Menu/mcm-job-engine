import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Tres huecos del sync de modificadores, todos medidos contra el merchant real antes de escribir
 * este test:
 *
 *  1. `g.deleted` / `m.deleted` NUNCA se comprobaban. `catalog-sync` sí lo hace para items y
 *     categorías. Un grupo borrado en Clover se re-creaba `status:'published'`.
 *  2. `m.available` se ignoraba: `stock_status` se escribía SIEMPRE `'instock'`, así que un
 *     modificador 86'eado en el POS seguía ofreciéndose en MCM.
 *  3. Cuando el floor guard bloqueaba el archive de modificadores, no dejaba NINGÚN rastro
 *     (productos y categorías sí loguean).
 *
 * Campos verificados en el merchant `7ES0TRRRYJCY1`:
 *   modifier_group → id, name, showByDefault, modifiers, modifierIds, deleted
 *   modifier       → id, name, available, price, modifiedTime, modifierGroup, deleted
 */

const h = vi.hoisted(() => ({
  ing: [] as any[], grp: [] as any[],
  updates: [] as any[], inserts: [] as any[], idSeq: 70000,
  grupos: [] as any[],
}));

vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/handlers/clover/sync/catalog-sync', async (orig) => {
  const real = await (orig() as any);
  return { ...real, fetchAllCloverElements: vi.fn(async () => ({ elements: h.grupos, complete: true })) };
});
vi.mock('../../src/lib/supabase', () => {
  const chain = (rows: any[]) => {
    const c: any = {
      eq: () => c, range: () => c, order: () => c, contains: () => c, limit: () => c,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (res: any) => res({ data: rows, error: null }),
    };
    return c;
  };
  const write = () => { const c: any = { eq: () => c, then: (r: any) => r({ error: null }) }; return c; };
  return {
    supabase: {
      from: (t: string) => ({
        select: () => chain(t === 'ingredients' ? h.ing : t === 'ingredients_groups' ? h.grp : []),
        insert: (row: any) => { h.inserts.push({ t, row }); return { select: () => ({ single: async () => ({ data: { id: ++h.idSeq }, error: null }) }) }; },
        update: (patch: any) => { h.updates.push({ t, patch }); return write(); },
      }),
    },
  };
});

import { syncCloverModifiers } from '../../src/handlers/clover/sync/modifier-sync';
import { logger } from '../../src/lib/logger';

beforeEach(() => { h.ing = []; h.grp = []; h.updates = []; h.inserts = []; h.idSeq = 70000; h.grupos = []; vi.clearAllMocks(); });

const grupo = (id: string, mods: any[], extra: any = {}) =>
  ({ id, name: `Grupo ${id}`, minRequired: 0, maxAllowed: 0, deleted: false, modifiers: { elements: mods }, ...extra });
const mod = (id: string, extra: any = {}) =>
  ({ id, name: `Mod ${id}`, price: 100, available: true, deleted: false, ...extra });

describe('sync de modificadores · deleted y available (defecto 1.3)', () => {
  it('un grupo con deleted:true NO se crea', async () => {
    h.grupos = [grupo('G1', [mod('M1')], { deleted: true })];
    const s = await syncCloverModifiers(99990004, {} as any, [], new Map());
    expect(s.groups.created).toBe(0);
    expect(h.inserts.some(i => i.t === 'ingredients_groups')).toBe(false);
  });

  it('un modificador con deleted:true NO se crea', async () => {
    h.grupos = [grupo('G1', [mod('M1', { deleted: true }), mod('M2')])];
    const s = await syncCloverModifiers(99990004, {} as any, [], new Map());
    expect(s.ingredients.created).toBe(1);   // sólo M2
    const nombres = h.inserts.filter(i => i.t === 'ingredients').map(i => i.row.name);
    expect(nombres).toEqual(['Mod M2']);
  });

  it('un grupo que pasa a deleted:true se ARCHIVA (no se re-publica)', async () => {
    // Escenario realista: 3 grupos, uno se borra. Con UNO SOLO el floor guard bloquearía a
    // propósito (`presentCount === 0` es un barrido sospechoso), que es conducta correcta.
    h.grp = ['G1', 'G2', 'G3'].map((cid, i) => ({
      id: 5 + i, name: `Grupo ${cid}`, label: `Grupo ${cid}`, minimum: 0, maximum: null,
      ingredients: [], products_included: [], additional_properties: { cloverId: cid } }));
    h.grupos = [grupo('G1', [], { deleted: true }), grupo('G2', []), grupo('G3', [])];
    const s = await syncCloverModifiers(99990004, {} as any, [], new Map());
    expect(s.groups.archived).toBe(1);
    const arch = h.updates.find(u => u.t === 'ingredients_groups' && u.patch?.additional_properties?.cloverArchived === true);
    expect(arch?.patch.status).toBe('draft');
  });

  it('m.available:false se refleja como outofstock (86 del modificador)', async () => {
    h.grupos = [grupo('G1', [mod('M1', { available: false })])];
    await syncCloverModifiers(99990004, {} as any, [], new Map());
    const ins = h.inserts.find(i => i.t === 'ingredients');
    expect(ins?.row.stock_status).toBe('outofstock');
  });

  it('un modificador que vuelve a estar disponible se re-habilita', async () => {
    h.ing = [{ id: 9, name: 'Mod M1', price: '1.00',
               additional_properties: { cloverId: 'M1' }, stock_status: 'outofstock' }];
    h.grupos = [grupo('G1', [mod('M1', { available: true })])];
    await syncCloverModifiers(99990004, {} as any, [], new Map());
    const up = h.updates.find(u => u.t === 'ingredients');
    expect(up?.patch.stock_status).toBe('instock');
  });

  it('cuando el floor guard bloquea el archive, DEJA RASTRO (defecto 1.9)', async () => {
    // 40 grupos existentes, Clover devuelve 1 → querría archivar 39, muy por encima del cap
    h.grp = Array.from({ length: 40 }, (_, i) => ({
      id: 100 + i, name: `G${i}`, label: `G${i}`, minimum: 0, maximum: null,
      ingredients: [], products_included: [], additional_properties: { cloverId: `G${i}` } }));
    h.grupos = [grupo('G0', [])];
    const s = await syncCloverModifiers(99990004, {} as any, [], new Map());
    expect(s.groups.archived).toBe(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    const args = vi.mocked(logger.warn).mock.calls.map(c => JSON.stringify(c));
    expect(args.some(a => a.includes('archive_skipped'))).toBe(true);
  });
});
