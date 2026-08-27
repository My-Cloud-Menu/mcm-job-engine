import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * A9 — el reconcile es INCREMENTAL: sólo borra lo que sobra y crea lo que falta.
 *
 * Lo que protege este test: una línea que no cambia debe CONSERVAR su
 * `line_item_id` de Clover. Ese id es el ancla que el modo gestionado usa para
 * correlacionar el POS con MCM; el DELETE+RECREATE anterior lo reasignaba en cada
 * push y el merge habría marcado TODAS las líneas como anuladas en el terminal.
 */

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), del: vi.fn(),
  orderUpdates: [] as Array<Record<string, unknown>>,
  cloverState: null as any,
}));

vi.mock('../../src/handlers/clover/client', () => ({
  createCloverClient: () => ({ get: h.get, post: h.post, delete: h.del }),
  CloverConfigSchema: { parse: (c: unknown) => c },
}));
vi.mock('../../src/lib/credentials', () => ({
  getSiteIntegrationConfig: vi.fn(async () => ({ config: { apiKey: 'k', merchantId: 'M' }, integrationId: 'i' })),
}));
vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), child: () => ({ info: vi.fn() }) },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      update: (patch: Record<string, unknown>) => { h.orderUpdates.push(patch); return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.cloverState }) }) }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

import '../../src/handlers/clover/inject/reconcile-items';
import { getHandler } from '../../src/handlers/registry';

const reconcile = getHandler('clover', 'reconcile_items')!;
const job = { id: 'job-1', site_id: 99990004, correlation_id: 'c' } as any;
const step = { idempotency_key: 'k:reconcile_items', attempt_count: 0, max_attempts: 5 } as any;

/** Estado actual en Clover que devuelve el GET. */
const cloverHas = (els: any[]) =>
  h.get.mockResolvedValue({ data: { total: 0, lineItems: { elements: els }, payments: { elements: [] } } });

const run = (desired: any[], hash = 'H2') =>
  reconcile({
    jobPayload: { order_id: 10, line_items: desired, line_items_hash: hash, order_total_cents: 1000 },
    context: { create_order: { clover_order_id: 'CLV1' } },
    job, step,
  } as any);

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.del.mockReset();
  h.orderUpdates.length = 0;
  h.cloverState = null;
  h.post.mockResolvedValue({ data: [], status: 200 });
});

describe('A9 · reconcile incremental', () => {
  it('sin cambios: CERO borrados y CERO creaciones — el ancla sobrevive', async () => {
    cloverHas([{ id: 'L1', name: 'Café', price: 250 }, { id: 'L2', name: 'Tostada', price: 400 }]);
    const res: any = await run([{ name: 'Café', price: 250 }, { name: 'Tostada', price: 400 }]);

    expect(h.del).not.toHaveBeenCalled();
    const bulk = h.post.mock.calls.filter((c) => String(c[0]).includes('bulk_line_items'));
    expect(bulk).toHaveLength(0);
    expect(res).toMatchObject({ kept: 2, removed: 0, added: 0 });
  });

  it('añadir un ítem: crea SÓLO el nuevo y no borra nada', async () => {
    cloverHas([{ id: 'L1', name: 'Café', price: 250 }]);
    h.post.mockResolvedValue({ data: [{ id: 'L9', name: 'Zumo', price: 300 }], status: 200 });

    const res: any = await run([{ name: 'Café', price: 250 }, { name: 'Zumo', price: 300 }]);

    expect(h.del).not.toHaveBeenCalled();
    const bulk = h.post.mock.calls.find((c) => String(c[0]).includes('bulk_line_items'));
    expect(bulk![1]).toEqual({ items: [{ name: 'Zumo', price: 300 }] });
    expect(res).toMatchObject({ kept: 1, removed: 0, added: 1 });
  });

  it('quitar un ítem: borra SÓLO ese id y no recrea nada', async () => {
    cloverHas([{ id: 'L1', name: 'Café', price: 250 }, { id: 'L2', name: 'Tostada', price: 400 }]);
    const res: any = await run([{ name: 'Café', price: 250 }]);

    expect(h.del).toHaveBeenCalledTimes(1);
    expect(String(h.del.mock.calls[0][0])).toContain('/line_items/L2');
    expect(h.post.mock.calls.filter((c) => String(c[0]).includes('bulk_line_items'))).toHaveLength(0);
    expect(res).toMatchObject({ kept: 1, removed: 1, added: 0 });
  });

  it('cambiar la cantidad de 1 a 3 conserva la existente y crea 2', async () => {
    cloverHas([{ id: 'L1', name: 'Café', price: 250 }]);
    h.post.mockResolvedValue({ data: [{ id: 'L2' }, { id: 'L3' }], status: 200 });

    const res: any = await run([{ name: 'Café', price: 250 }, { name: 'Café', price: 250 }, { name: 'Café', price: 250 }]);

    expect(h.del).not.toHaveBeenCalled();
    const bulk = h.post.mock.calls.find((c) => String(c[0]).includes('bulk_line_items'));
    expect((bulk![1] as any).items).toHaveLength(2);
    expect(res).toMatchObject({ kept: 1, removed: 0, added: 2 });
  });

  it('el GET pide tasas y modificaciones (si no, la firma seria incorrecta)', async () => {
    cloverHas([]);
    await run([]);
    const url = String(h.get.mock.calls[0][0]);
    expect(url).toContain('lineItems.taxRates');
    expect(url).toContain('lineItems.modifications');
  });

  it('MODO DE FALLO SEGURO: si nada empareja, degrada a borrar todo y recrear', async () => {
    cloverHas([{ id: 'L1', name: 'Viejo', price: 100 }, { id: 'L2', name: 'Viejo2', price: 200 }]);
    h.post.mockResolvedValue({ data: [{ id: 'N1' }, { id: 'N2' }], status: 200 });

    const res: any = await run([{ name: 'Nuevo', price: 900 }, { name: 'Nuevo2', price: 800 }]);

    expect(h.del).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ kept: 0, removed: 2, added: 2 });
  });

  it('el hash sin cambios sigue cortocircuitando antes de tocar Clover', async () => {
    h.cloverState = { clover_ticket_id: 'CLV1', clover_line_items_hash: 'H2' };
    const res: any = await run([{ name: 'X', price: 1 }], 'H2');
    expect(res).toEqual({ skipped: 'hash_unchanged' });
    expect(h.get).not.toHaveBeenCalled();
  });
});
