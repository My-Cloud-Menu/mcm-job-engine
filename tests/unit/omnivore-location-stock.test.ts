import { describe, it, expect, vi, beforeEach } from 'vitest';
import { newMemState, makeMemSupabase, writesTo, hasSiteFilter, MemState } from './helpers/memory-supabase';

const h = vi.hoisted(() => ({ state: null as unknown as MemState }));
vi.mock('../../src/lib/supabase', () => ({
  get supabase() {
    return makeMemSupabase(h.state);
  },
}));
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  OMNIVORE_OOS_REASON,
  applyLocationStock,
  desiredOutOfStock,
  diffLocationStock,
  omnivoreIdMap,
} from '../../src/handlers/omnivore/sync/inventory/location-stock';

const SITE = 71000000;
const LOC = 71000001;
const base = { variation_id: null, channel_code: null, catalog_id: null };

describe('diffLocationStock (C3, PURA)', () => {
  it('crea lo nuevo, borra lo suyo que volvió y nunca toca filas de otro origen', () => {
    const existing = [
      { id: 1, entity_type: 'product', entity_id: 10, reason: OMNIVORE_OOS_REASON, ...base },  // sigue agotado
      { id: 2, entity_type: 'product', entity_id: 11, reason: OMNIVORE_OOS_REASON, ...base },  // volvió → borrar
      { id: 3, entity_type: 'product', entity_id: 12, reason: 'Se acabó', ...base },             // 86 manual, Aloha también
      { id: 4, entity_type: 'product', entity_id: 13, reason: 'no-se-vende-en-sucursal', ...base }, // manual, Aloha no
      { id: 5, entity_type: 'product', entity_id: 14, reason: OMNIVORE_OOS_REASON, ...base, channel_code: 'uber' }, // otro alcance
    ];
    const desired = new Map([
      ['product:10', { entity_type: 'product' as const, entity_id: 10 }],
      ['product:12', { entity_type: 'product' as const, entity_id: 12 }],
      ['ingredient:20', { entity_type: 'ingredient' as const, entity_id: 20 }],
    ]);
    const d = diffLocationStock(existing, desired);
    expect(d.insert).toEqual([{ entity_type: 'ingredient', entity_id: 20 }]);
    expect(d.deleteIds).toEqual([2]);
  });

  it('mapea ids de Aloha a MCM y cuenta los que no existen en MCM', () => {
    const products = omnivoreIdMap([{ id: 10, additional_properties: { omnivoreId: '501' } }, { id: 11, additional_properties: {} }]);
    const ingredients = omnivoreIdMap([{ id: '20', additional_properties: { omnivoreId: 835095 } }]);
    const { desired, unmapped } = desiredOutOfStock([{ id: '501' }, { id: '999' }], [{ id: '835095' }], products, ingredients);
    expect([...desired.keys()]).toEqual(['product:10', 'ingredient:20']);
    expect(unmapped).toBe(1);
  });
});

describe('applyLocationStock (C3, con base en memoria)', () => {
  beforeEach(() => {
    h.state = newMemState({
      stock_availability: [
        { id: 1, site_id: SITE, location_id: LOC, entity_type: 'product', entity_id: 11, reason: OMNIVORE_OOS_REASON, status: 'out_of_stock', ...base },
        { id: 2, site_id: SITE, location_id: LOC, entity_type: 'product', entity_id: 12, reason: 'Se acabó', status: 'out_of_stock', ...base },
        { id: 3, site_id: SITE, location_id: 71000002, entity_type: 'product', entity_id: 11, reason: OMNIVORE_OOS_REASON, status: 'out_of_stock', ...base },
        { id: 4, site_id: 51021421, location_id: LOC, entity_type: 'product', entity_id: 11, reason: OMNIVORE_OOS_REASON, status: 'out_of_stock', ...base },
      ],
    });
    h.state.unique.stock_availability = [['site_id', 'entity_type', 'entity_id', 'location_id']];
  });

  it('escribe solo la diferencia de ESA sucursal de ESE negocio', async () => {
    const desired = new Map([
      ['product:12', { entity_type: 'product' as const, entity_id: 12 }],
      ['product:13', { entity_type: 'product' as const, entity_id: 13 }],
    ]);
    const r = await applyLocationStock(SITE, LOC, desired);
    expect(r).toEqual({ inserted: 1, deleted: 1 });
    const rows = h.state.tables.stock_availability!;
    expect(rows.find((x) => x.id === 1)).toBeUndefined();                 // el suyo que volvió: borrado
    expect(rows.find((x) => x.id === 2)?.reason).toBe('Se acabó');        // 86 manual: intacto
    expect(rows.find((x) => x.id === 3)).toBeDefined();                    // otra sucursal: intacta
    expect(rows.find((x) => x.id === 4)).toBeDefined();                    // otro negocio: intacto
    expect(rows.find((x) => x.entity_id === 13)).toMatchObject({ site_id: SITE, location_id: LOC, status: 'out_of_stock', reason: OMNIVORE_OOS_REASON });
    for (const w of writesTo(h.state, 'stock_availability').filter((o) => o.op === 'delete')) {
      expect(hasSiteFilter(w, SITE)).toBe(true);
      expect(w.filters).toContainEqual(['eq', 'reason', OMNIVORE_OOS_REASON]);
      expect(w.filters).toContainEqual(['eq', 'location_id', LOC]);
    }
  });

  it('si alguien marcó lo mismo a la vez (23505), sigue fila por fila sin pisarlo', async () => {
    // Entre la lectura y la escritura alguien creó un 86 manual del producto 13 en esta sucursal.
    const realFrom = makeMemSupabase(h.state).from;
    let injected = false;
    vi.spyOn(await import('../../src/lib/supabase'), 'supabase', 'get').mockReturnValue({
      ...makeMemSupabase(h.state),
      from(name: string) {
        const b = realFrom(name);
        if (name === 'stock_availability' && !injected) {
          const origInsert = b.insert;
          b.insert = (payload: any) => {
            injected = true;
            h.state.tables.stock_availability!.push({ id: 99, site_id: SITE, location_id: LOC, entity_type: 'product', entity_id: 13, reason: 'manual', ...base });
            return origInsert(payload);
          };
        }
        return b;
      },
    } as any);
    const desired = new Map([
      ['product:13', { entity_type: 'product' as const, entity_id: 13 }],
      ['product:14', { entity_type: 'product' as const, entity_id: 14 }],
    ]);
    const r = await applyLocationStock(SITE, LOC, desired);
    expect(r.inserted).toBe(1);
    const rows = h.state.tables.stock_availability!.filter((x) => x.location_id === LOC && x.site_id === SITE);
    expect(rows.find((x) => x.entity_id === 13)?.reason).toBe('manual');
    expect(rows.find((x) => x.entity_id === 14)?.reason).toBe(OMNIVORE_OOS_REASON);
  });
});
