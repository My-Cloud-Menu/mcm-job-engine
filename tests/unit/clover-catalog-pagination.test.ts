import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * PostgREST corta las lecturas en `db-max-rows` (1000 por defecto en Supabase) **en silencio**:
 * no hay error, sólo faltan filas. El sync de catálogo de Clover leía "todos los productos del
 * site" sin `.range()`, así que en un catálogo de >1000 productos:
 *
 *   - los productos 1001+ no entran en el mapa `byClover` → se ven como NUEVOS y se intenta
 *     insertarlos (los salva el índice único parcial, pero infla los contadores y hace un
 *     UPDATE por cada uno en cada corrida),
 *   - los realmente borrados en Clover más allá de la fila 1000 **nunca se archivan**,
 *   - y el pull de órdenes deja de resolver `product_id` para esos productos.
 *
 * El mock de abajo reproduce el corte: un `select` SIN `.range()` devuelve como mucho 1000 filas;
 * con `.range(a,b)` devuelve la rebanada pedida. Es la única forma honesta de probarlo sin una
 * base de datos con 1500 productos.
 */

const PAGE_CAP = 1000;

const h = vi.hoisted(() => ({
  filas: [] as any[],       // "todas" las filas que hay en la tabla para el site
  updates: [] as any[],
  inserts: [] as any[],
  idSeq: 50000,
  rangosPedidos: [] as Array<[number, number]>,
}));

vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/handlers/clover/sync/rate-limit', () => ({
  acquireCloverCatalogToken: vi.fn(async () => {}),
  _resetCloverCatalogBucket: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => {
  const selectChain = () => {
    let desde: number | null = null;
    let hasta: number | null = null;
    const resolver = () => {
      if (desde === null) {
        // SIN .range(): PostgREST aplica db-max-rows y corta EN SILENCIO.
        return { data: h.filas.slice(0, PAGE_CAP), error: null };
      }
      h.rangosPedidos.push([desde, hasta!]);
      return { data: h.filas.slice(desde, hasta! + 1), error: null };
    };
    const c: any = {
      eq: () => c,
      contains: () => c,
      limit: () => c,
      order: () => c,
      range: (a: number, b: number) => { desde = a; hasta = b; return c; },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (res: any) => res(resolver()),
    };
    return c;
  };
  const writeChain = () => { const c: any = { eq: () => c, then: (res: any) => res({ error: null }) }; return c; };
  return {
    supabase: {
      from: () => ({
        select: () => selectChain(),
        insert: (row: any) => {
          h.inserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: ++h.idSeq }, error: null }) }) };
        },
        update: (patch: any) => { h.updates.push(patch); return writeChain(); },
      }),
    },
  };
});

import { syncCloverProducts, syncCloverItemStock } from '../../src/handlers/clover/sync/catalog-sync';

beforeEach(() => { h.filas = []; h.updates = []; h.inserts = []; h.idSeq = 50000; h.rangosPedidos = []; });

const N = 1500;
const itemClover = (i: number) => ({
  id: `CLV${i}`, name: `Item ${i}`, price: 100 + i, available: true,
  categories: { elements: [] }, taxRates: { elements: [] },
});
const filaMcm = (i: number) => ({
  id: 900000 + i, name: `Item ${i}`, description: '', price: ((100 + i) / 100).toFixed(2), sku: '',
  status: 'published', stock_status: 'instock', tax_class: 'standard', is_taxable: true,
  categories_id: [], additional_properties: { cloverId: `CLV${i}` },
});

describe('paginación de las lecturas a Supabase (defecto 1.1)', () => {
  it('un catálogo de 1500 productos SIN CAMBIOS no debe crear ni actualizar nada', async () => {
    h.filas = Array.from({ length: N }, (_, i) => filaMcm(i));
    const items = Array.from({ length: N }, (_, i) => itemClover(i));

    const { stats } = await syncCloverProducts(99990004, items, true, new Map());

    // Con el corte en 1000, los 500 últimos se ven como nuevos → inserts y updates espurios.
    expect(stats.created).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(N);
    expect(h.inserts).toHaveLength(0);
  });

  it('pide las páginas con .range() y cubre las 1500 filas', async () => {
    h.filas = Array.from({ length: N }, (_, i) => filaMcm(i));
    await syncCloverProducts(99990004, Array.from({ length: N }, (_, i) => itemClover(i)), true, new Map());

    expect(h.rangosPedidos.length).toBeGreaterThanOrEqual(2);
    const cubierto = Math.max(...h.rangosPedidos.map(([, b]) => b)) + 1;
    expect(cubierto).toBeGreaterThanOrEqual(N);
  });

  it('un producto borrado en Clover MÁS ALLÁ de la fila 1000 sí se archiva', async () => {
    h.filas = Array.from({ length: N }, (_, i) => filaMcm(i));
    // Clover ya no devuelve el 1400 (borrado de verdad)
    const items = Array.from({ length: N }, (_, i) => itemClover(i)).filter((_, i) => i !== 1400);

    const { stats } = await syncCloverProducts(99990004, items, true, new Map());

    expect(stats.archived).toBe(1);
    const archivado = h.updates.find((u: any) => u?.additional_properties?.cloverArchived === true);
    expect(archivado).toBeTruthy();
    expect(archivado.status).toBe('draft');
  });

  it('el 86 de un producto más allá de la fila 1000 también se refleja', async () => {
    h.filas = Array.from({ length: N }, (_, i) => filaMcm(i));
    const items = Array.from({ length: N }, (_, i) => itemClover(i));
    items[1200] = { ...items[1200], available: false };   // 86'eado en Clover

    const stats = await syncCloverItemStock(99990004, items);

    expect(stats.updated).toBe(1);
    expect(h.updates.some((u: any) => u.stock_status === 'outofstock')).toBe(true);
  });
});
