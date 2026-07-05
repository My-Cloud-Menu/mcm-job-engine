import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  existing: [] as any[],   // rows returned by products.select().eq('site_id')
  updates: [] as any[],    // captured update patches
  inserts: [] as any[],    // captured insert rows
  idSeq: 50000,
  insert23505Once: false,  // simulate a concurrent UNIQUE(site_id,cloverId) race on the next insert
  dupeRow: null as any,    // row returned by the insertOrAdopt dupe lookup after a 23505
}));

vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/handlers/clover/sync/rate-limit', () => ({
  acquireCloverCatalogToken: vi.fn(async () => {}),
  _resetCloverCatalogBucket: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => {
  // supports both the array read (await ...eq()) and the insertOrAdopt dupe lookup
  // (...eq().contains().limit().maybeSingle()).
  const selectChain = (rows: any[]) => {
    const c: any = {
      eq: () => c, contains: () => c, limit: () => c,
      maybeSingle: async () => ({ data: h.dupeRow ?? null, error: null }),
      then: (res: any) => res({ data: rows, error: null }),
    };
    return c;
  };
  const writeChain = () => {
    const c: any = { eq: () => c, then: (res: any) => res({ error: null }) };
    return c;
  };
  return {
    supabase: {
      from: () => ({
        select: () => selectChain(h.existing),
        insert: (row: any) => {
          h.inserts.push(row);
          const raise = h.insert23505Once;
          if (raise) h.insert23505Once = false;
          return { select: () => ({ single: async () => (raise ? { data: null, error: { code: '23505' } } : { data: { id: ++h.idSeq }, error: null }) }) };
        },
        update: (patch: any) => { h.updates.push(patch); return writeChain(); },
      }),
    },
  };
});

import { fetchAllCloverElements, syncCloverProducts, syncCloverItemStock } from '../../src/handlers/clover/sync/catalog-sync';
import { logger } from '../../src/lib/logger';

beforeEach(() => { h.existing = []; h.updates = []; h.inserts = []; h.idSeq = 50000; h.insert23505Once = false; h.dupeRow = null; });

const item = (id: string, price: number, available = true) => ({ id, name: `Item ${id}`, price, available, categories: { elements: [] }, taxRates: { elements: [] } });
const prod = (cloverId: string, price: number, extra: any = {}) => ({
  id: 900 + Number(cloverId.replace(/\D/g, '') || 0), name: `Item ${cloverId}`, price, status: 'published',
  stock_status: 'instock', tax_class: 'standard', categories_id: [], additional_properties: { cloverId }, ...extra,
});

describe('fetchAllCloverElements (G6 pagination + cap)', () => {
  it('paginates across pages and marks complete', async () => {
    const pages = [
      { data: { elements: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}` })) } },
      { data: { elements: Array.from({ length: 30 }, (_, i) => ({ id: `q${i}` })) } },
    ];
    let call = 0;
    const client: any = { get: vi.fn(async () => pages[call++]) };
    const { elements, complete } = await fetchAllCloverElements(client, 1, '/items');
    expect(elements.length).toBe(130);
    expect(complete).toBe(true);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('caps at MAX_PAGES, logs, and returns complete=false (no silent truncation)', async () => {
    const client: any = { get: vi.fn(async () => ({ data: { elements: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}` })) } })) };
    const { elements, complete } = await fetchAllCloverElements(client, 1, '/items');
    expect(complete).toBe(false);
    expect(elements.length).toBe(6000); // 60 pages * 100
    expect((logger.warn as any)).toHaveBeenCalledWith(expect.objectContaining({ path: '/items' }), 'clover_catalog_pagination_capped');
  });

  it('CURSOR mode (by id): sweeps every page past the offset cap and completes', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ id: `a${String(i).padStart(3, '0')}` })),
      Array.from({ length: 100 }, (_, i) => ({ id: `b${String(i).padStart(3, '0')}` })),
      Array.from({ length: 50 }, (_, i) => ({ id: `c${String(i).padStart(3, '0')}` })),
    ];
    let call = 0;
    const client: any = { get: vi.fn(async () => ({ data: { elements: pages[call++] } })) };
    const { elements, complete } = await fetchAllCloverElements(client, 1, '/items', undefined, { cursorField: 'id' });
    expect(elements.length).toBe(250);
    expect(complete).toBe(true);
  });

  it('CURSOR mode: stops (complete=false, no silent truncation) if the cursor never advances', async () => {
    // pathological: every page returns the same id (>PAGE tie cluster) → the stuck guard trips.
    const client: any = { get: vi.fn(async () => ({ data: { elements: Array.from({ length: 100 }, () => ({ id: 'SAME' })) } })) };
    const { complete } = await fetchAllCloverElements(client, 1, '/items', undefined, { cursorField: 'id' });
    expect(complete).toBe(false);
    expect((logger.warn as any)).toHaveBeenCalledWith(expect.objectContaining({ path: '/items' }), 'clover_catalog_cursor_stuck');
  });
});

describe('syncCloverProducts (idempotency + soft-archive)', () => {
  it('creates all products when none exist', async () => {
    const { stats } = await syncCloverProducts(1, [item('a', 550), item('b', 0)], true, new Map());
    expect(stats.created).toBe(2);
    expect(stats.updated).toBe(0);
    expect(h.inserts.length).toBe(2);
  });

  it('is idempotent — unchanged products (incl. prices ending in 0 cents) are skipped', async () => {
    h.existing = [prod('a', 5.5), prod('b', 0)]; // DB numeric 5.5 vs Clover 550¢→"5.50"
    const { stats } = await syncCloverProducts(1, [item('a', 550), item('b', 0)], true, new Map());
    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(2);
    expect(h.updates.length).toBe(0); // NO writes — the price-cents fix
  });

  it('updates when price actually changed', async () => {
    h.existing = [prod('a', 5.5)];
    const { stats } = await syncCloverProducts(1, [item('a', 599)], true, new Map());
    expect(stats.updated).toBe(1);
    expect(String(h.updates[0].price)).toBe('5.99');
  });

  it('soft-archives (never deletes) a vanished product only on a COMPLETE sweep', async () => {
    h.existing = [prod('a', 550), prod('gone', 100)];
    const { stats } = await syncCloverProducts(1, [item('a', 550)], true, new Map());
    expect(stats.archived).toBe(1);
    const archivePatch = h.updates.find((u) => u.additional_properties?.cloverArchived === true);
    expect(archivePatch).toBeTruthy();
    expect(archivePatch.status).toBe('draft');
    expect(archivePatch.stock_status).toBe('outofstock');
  });

  it('does NOT archive on an incomplete sweep (partial page safety)', async () => {
    h.existing = [prod('a', 550), prod('gone', 100)];
    const { stats } = await syncCloverProducts(1, [item('a', 550)], false, new Map());
    expect(stats.archived).toBe(0);
    expect(h.updates.find((u) => u.additional_properties?.cloverArchived === true)).toBeFalsy();
  });

  it('archive FLOOR GUARD: refuses to wipe the catalog when a "complete" sweep shows an implausibly small subset', async () => {
    // 20 existing, but a degraded/short 200 page returned only 2 → complete=true would archive 18.
    h.existing = Array.from({ length: 20 }, (_, i) => prod(`c${i}`, 100));
    const items = [item('c0', 100), item('c1', 100)];
    const { stats } = await syncCloverProducts(1, items, true, new Map());
    expect(stats.archived).toBe(0); // floor guard blocks the mass-wipe
    expect(h.updates.find((u) => u.additional_properties?.cloverArchived === true)).toBeFalsy();
  });

  it('archive allows a normal small shrink (a few genuine deletions) on a complete sweep', async () => {
    h.existing = Array.from({ length: 20 }, (_, i) => prod(`c${i}`, 100));
    const items = Array.from({ length: 18 }, (_, i) => item(`c${i}`, 100)); // 2 genuinely gone
    const { stats } = await syncCloverProducts(1, items, true, new Map());
    expect(stats.archived).toBe(2);
  });

  it('adopts (updates, not duplicates) when a concurrent insert won the UNIQUE race (23505)', async () => {
    // no existing row → insert path; the fake supabase raises 23505 once, then the dupe lookup returns a row.
    h.existing = [];
    h.insert23505Once = true;
    h.dupeRow = { id: 77777 };
    const { stats, cloverIdToMcmId } = await syncCloverProducts(1, [item('a', 550)], true, new Map());
    expect(stats.created).toBe(0);
    expect(stats.updated).toBe(1); // adopted + updated instead of duplicating
    expect(cloverIdToMcmId.get('a')).toBe(77777);
  });
});

describe('syncCloverItemStock (86)', () => {
  it('flips a product to outofstock/draft when Clover item goes unavailable', async () => {
    h.existing = [prod('a', 550, { status: 'published', stock_status: 'instock' })];
    const stats = await syncCloverItemStock(1, [item('a', 550, false)]);
    expect(stats.updated).toBe(1);
    expect(h.updates[0].stock_status).toBe('outofstock');
    expect(h.updates[0].status).toBe('draft');
  });

  it('skips when stock status is unchanged', async () => {
    h.existing = [prod('a', 550, { stock_status: 'instock' })];
    const stats = await syncCloverItemStock(1, [item('a', 550, true)]);
    expect(stats.updated).toBe(0);
    expect(h.updates.length).toBe(0);
  });
});
