/**
 * Catálogo (Misión Omnivore Multisucursal, F3): C3 (sin stock_status cuando hay agotados por sucursal), C9 (niveles de
 * precio de modificadores al día) y T1 (`site_id` en niveles de precio de producto). Base en memoria.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { newMemState, makeMemSupabase, writesTo, hasSiteFilter, MemState } from './helpers/memory-supabase';

const h = vi.hoisted(() => ({ state: null as unknown as MemState }));
vi.mock('../../src/lib/supabase', () => ({
  get supabase() {
    return makeMemSupabase(h.state);
  },
}));
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getProductsChangesToSyncOmnivore } from '../../src/handlers/omnivore/sync/inventory/products-helper';
import { getIngredientsChangesToSyncOmnivore, omnivorePriceLevelsOf } from '../../src/handlers/omnivore/sync/inventory/ingredients-helper';
import { batchPriceLevels } from '../../src/handlers/omnivore/sync/inventory/products-write';

const SITE = 51021421;
const product = (id: string, inStock: boolean, cents = 500) => ({
  id, name: `P${id}`, price_per_unit: cents, in_stock: inStock, pos_id: id, open: false,
  _embedded: { menu_categories: [], price_levels: [] },
} as any);
const modifier = (id: string, cents: number, levels: Array<[string, string, number]>, inStock = true) => ({
  id, name: `M${id}`, price_per_unit: cents, in_stock: inStock, pos_id: id, open: false,
  _embedded: { price_levels: levels.map(([lid, name, c]) => ({ id: lid, name, price_per_unit: c })) },
} as any);

beforeEach(() => {
  h.state = newMemState({
    categories: [],
    products: [
      { id: 1, site_id: SITE, name: 'P1', price: 5, stock_status: 'instock', additional_properties: { omnivoreId: '1', omnivoreName: 'P1' } },
      { id: 2, site_id: SITE, name: 'P2', price: 5, stock_status: 'outofstock', additional_properties: { omnivoreId: '2', omnivoreName: 'P2' } },
    ],
    ingredients: [
      { id: 10298, site_id: SITE, name: 'Double', price: 0, stock_status: 'instock', additional_properties: { omnivoreId: '835095', omnivorePriceLevels: [
        { id: 'b7', name: 'BAR 19', price: 13.3 }, { id: 'b8', name: 'BAR 20', price: 14 }, { id: 'i6', name: 'UPGRADE', price: 0 },
      ] } },
      { id: 30, site_id: SITE, name: 'Mx', price: 1, stock_status: 'instock', additional_properties: { omnivoreId: '30' } },
    ],
  });
});

describe('productos: stock_status (C3)', () => {
  it('una conexión (manageStock true): igual que siempre — el agotado de Aloha llega al producto', async () => {
    const ch = await getProductsChangesToSyncOmnivore(SITE, [product('1', false), product('2', true), product('3', false)], 'published', false);
    expect(ch.update.map((u) => [u.id, u.stock_status])).toEqual([[1, 'outofstock'], [2, 'instock']]);
    expect(ch.create[0]).toMatchObject({ name: 'P3', stock_status: 'outofstock' });
  });

  it('agotados por sucursal (manageStock false): el catálogo NO toca stock_status; lo nuevo nace disponible', async () => {
    const ch = await getProductsChangesToSyncOmnivore(SITE, [product('1', false), product('2', true), product('3', false)], 'published', false, false);
    expect(ch.update).toEqual([]);                                          // solo cambiaba el stock → nada
    expect(ch.create[0]).toMatchObject({ name: 'P3', stock_status: 'instock' });
    const ch2 = await getProductsChangesToSyncOmnivore(SITE, [product('1', false, 900)], 'published', false, false);
    expect(ch2.update).toHaveLength(1);
    expect(ch2.update[0]).not.toHaveProperty('stock_status');               // cambia el precio, no el stock
    expect(ch2.update[0]).toMatchObject({ id: 1, price: 9 });
  });
});

describe('modificadores: C9 y stock_status', () => {
  it('C9: el caso real de Arena — «Double» pierde «BAR 20» → se actualizan sus niveles', async () => {
    const ch = await getIngredientsChangesToSyncOmnivore(SITE, [modifier('835095', 0, [['b7', 'BAR 19', 1330], ['i6', 'UPGRADE', 0]])]);
    expect(ch.update).toHaveLength(1);
    expect(ch.update[0].additional_properties.omnivorePriceLevels).toEqual([
      { id: 'b7', name: 'BAR 19', price: 13.3 }, { id: 'i6', name: 'UPGRADE', price: 0 },
    ]);
    expect(ch.update[0].additional_properties.omnivoreId).toBe('835095');
  });

  it('C9: sin cambios en Aloha → sin update; un nivel o ninguno → [] (sin escribir si no había)', async () => {
    const same = await getIngredientsChangesToSyncOmnivore(SITE, [
      modifier('835095', 0, [['b7', 'BAR 19', 1330], ['b8', 'BAR 20', 1400], ['i6', 'UPGRADE', 0]]),
      modifier('30', 100, [['x', 'solo', 100]]),
    ]);
    expect(same.update).toEqual([]);
  });

  it('C9: en un update por precio, los niveles iguales no se reescriben (additional_properties como antes)', async () => {
    const ch = await getIngredientsChangesToSyncOmnivore(SITE, [modifier('30', 250, [])]);
    expect(ch.update[0].additional_properties).toEqual({ omnivoreId: '30' });
  });

  it('crear usa la misma regla de niveles que refrescar', async () => {
    const m = modifier('77', 0, [['a', 'A', 100], ['b', 'B', 250]]);
    const ch = await getIngredientsChangesToSyncOmnivore(SITE, [m]);
    expect(ch.create[0].additional_properties.omnivorePriceLevels).toEqual(omnivorePriceLevelsOf(m));
  });

  it('manageStock false: el agotado de la sucursal fuente no llega al modificador del negocio', async () => {
    const ch = await getIngredientsChangesToSyncOmnivore(SITE, [modifier('30', 100, [], false)], false);
    expect(ch.update).toEqual([]);
    const ch2 = await getIngredientsChangesToSyncOmnivore(SITE, [modifier('30', 100, [], false)], true);
    expect(ch2.update[0]).toMatchObject({ id: 30, stock_status: 'outofstock' });
  });
});

describe('T1: niveles de precio de producto con site_id', () => {
  it('borrar y actualizar llevan el negocio', async () => {
    h.state.tables.product_price_levels = [{ id: 5, site_id: SITE }, { id: 6, site_id: SITE }, { id: 7, site_id: SITE }];
    await batchPriceLevels(SITE, {
      delete: [{ id: 5 }],
      update: [{ id: 6, code: 'A', price: 1, is_default: false }, { id: 7, code: 'B', price: 2, is_default: true }],
      create: [],
    });
    const ws = writesTo(h.state, 'product_price_levels');
    expect(ws.map((w) => w.op)).toEqual(['delete', 'update', 'update']);
    for (const w of ws) expect(hasSiteFilter(w, SITE)).toBe(true);
  });
});
