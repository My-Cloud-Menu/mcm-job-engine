import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  orderUpdates: [] as Array<Record<string, unknown>>,
  cloverState: null as { clover_ticket_id: string | null; clover_line_items_hash: string | null } | null,
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
      update: (patch: Record<string, unknown>) => {
        h.orderUpdates.push(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.cloverState }) }) }) }),
    }),
    // The paid-primary path calls claim_clover_supplement; default = no delta.
    rpc: async (fn: string) => ({
      data: fn === 'claim_clover_supplement' ? { has_delta: false, has_removal: false } : null,
      error: null,
    }),
  },
}));

import '../../src/handlers/clover/inject/create-order';
import '../../src/handlers/clover/inject/reconcile-items';
import { getHandler } from '../../src/handlers/registry';
import { HandlerError } from '../../src/core/types';

const createOrder = getHandler('clover', 'create_order')!;
const reconcile = getHandler('clover', 'reconcile_items')!;
const job = { id: 'job-1', site_id: 25, correlation_id: 'c' } as any;
const orderBody = { note: 'x', title: 'MCM #5', state: 'Open', externalReferenceId: 'mABC' };

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.del.mockReset();
  h.orderUpdates.length = 0;
  h.cloverState = null;
});

describe('clover create_order handler', () => {
  const step = { idempotency_key: 'clover_inject:5:H1:create_order', attempt_count: 0, max_attempts: 3 } as any;
  const run = () =>
    createOrder({
      stepInput: {},
      jobPayload: { order_id: 5, order_body: orderBody, external_reference_id: 'mABC' },
      context: {},
      job,
      step,
    });

  it('adopts the ticket already persisted on the order (DB dedup, filter-independent)', async () => {
    h.cloverState = { clover_ticket_id: 'CLOVER-DB', clover_line_items_hash: null };
    const out = await run();
    expect(out).toMatchObject({ clover_order_id: 'CLOVER-DB', adopted: true });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('adopts an existing Clover order by externalReferenceId', async () => {
    h.get.mockResolvedValue({ data: { elements: [{ id: 'CLOVER-EXIST' }] } });
    const out = await run();
    expect(out).toMatchObject({ clover_order_id: 'CLOVER-EXIST', adopted: true });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.orderUpdates[0]).toMatchObject({ clover_ticket_id: 'CLOVER-EXIST', pos_injection_error: null });
  });

  it('creates the order and persists clover_ticket_id', async () => {
    h.get.mockResolvedValue({ data: { elements: [] } });
    h.post.mockResolvedValue({ data: { id: 'CLOVER-NEW' }, status: 201 });
    const out = await run();
    expect(out).toMatchObject({ clover_order_id: 'CLOVER-NEW' });
    expect(h.post).toHaveBeenCalledWith('/orders', orderBody);
    expect(h.orderUpdates[0]).toMatchObject({ clover_ticket_id: 'CLOVER-NEW' });
  });

  it('business error (400) → non-retryable + records pos_injection_error', async () => {
    h.get.mockResolvedValue({ data: { elements: [] } });
    h.post.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { message: 'bad price' } } });
    await expect(run()).rejects.toBeInstanceOf(HandlerError);
    const errUpd = h.orderUpdates.find((u) => 'pos_injection_error' in u && u.pos_injection_error);
    expect(errUpd).toBeTruthy();
    expect((errUpd!.pos_injection_error as any).provider).toBe('clover');
  });
});

describe('clover reconcile_items handler', () => {
  const step = { idempotency_key: 'clover_inject:5:H2:reconcile_items', attempt_count: 0, max_attempts: 5 } as any;
  const lineItems = [{ name: 'Burger', price: 1000, taxRates: [{ id: 'T1', name: 'Tax', rate: 1050000, taxAmount: 105 }] }];
  const run = (li: unknown[] = lineItems) =>
    reconcile({
      stepInput: {},
      jobPayload: { order_id: 5, line_items: li, line_items_hash: 'H2' },
      context: { create_order: { clover_order_id: 'CLOVER-1' } },
      job,
      step,
    });

  it('skips when the desired hash already matches (resume guard)', async () => {
    h.cloverState = { clover_ticket_id: 'CLOVER-1', clover_line_items_hash: 'H2' };
    const out = await run();
    expect(out).toMatchObject({ skipped: 'hash_unchanged' });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('reconciles: deletes existing, bulk-creates desired, persists hash', async () => {
    h.cloverState = { clover_ticket_id: 'CLOVER-1', clover_line_items_hash: 'H1' };
    h.get.mockResolvedValue({ data: { lineItems: { elements: [{ id: 'li1' }, { id: 'li2' }] }, payments: { elements: [] } } });
    h.del.mockResolvedValue({});
    h.post.mockResolvedValue({ data: {} });

    const out = await run();

    expect(out).toMatchObject({ removed: 2, added: 1 });
    expect(h.del).toHaveBeenCalledTimes(2);
    expect(h.post).toHaveBeenCalledWith('/orders/CLOVER-1/bulk_line_items', { items: lineItems });
    expect(h.orderUpdates.find((u) => u.clover_line_items_hash === 'H2')).toBeTruthy();
  });

  it('CHUNKS bulk_line_items into <=100 per request (Clover caps a single request at 100)', async () => {
    h.cloverState = { clover_ticket_id: 'CLOVER-1', clover_line_items_hash: 'H1' };
    h.get.mockResolvedValue({ data: { lineItems: { elements: [] }, payments: { elements: [] } } });
    h.del.mockResolvedValue({});
    h.post.mockResolvedValue({ data: [] }); // bulk returns a bare array
    const big = Array.from({ length: 150 }, (_, i) => ({ name: `X${i}`, price: 100 }));
    await run(big);
    const bulkCalls = h.post.mock.calls.filter((c: any) => String(c[0]).endsWith('/bulk_line_items'));
    expect(bulkCalls.length).toBe(2); // 100 + 50, not one 150-item POST (which Clover 400s)
    expect((bulkCalls[0][1] as any).items.length).toBe(100);
    expect((bulkCalls[1][1] as any).items.length).toBe(50);
  });

  // Fix total $0.00: Clover no computa order.total al agregar items vía bulk_line_items.
  // Tras el bulk add, asentamos el total congelado por el edge (Σ price+taxAmount).
  it('sets order.total via POST /orders/{id} AFTER the bulk add when order_total_cents is present', async () => {
    h.cloverState = { clover_ticket_id: 'CLOVER-1', clover_line_items_hash: 'H1' };
    h.get.mockResolvedValue({ data: { lineItems: { elements: [{ id: 'li1' }] }, payments: { elements: [] } } });
    h.del.mockResolvedValue({});
    h.post.mockResolvedValue({ data: {} });

    await reconcile({
      stepInput: {},
      jobPayload: { order_id: 5, line_items: lineItems, line_items_hash: 'H2', order_total_cents: 1105 },
      context: { create_order: { clover_order_id: 'CLOVER-1' } },
      job,
      step,
    });

    expect(h.post).toHaveBeenCalledWith('/orders/CLOVER-1/bulk_line_items', { items: lineItems });
    expect(h.post).toHaveBeenCalledWith('/orders/CLOVER-1', { total: 1105 });
    // El set-total ocurre DESPUÉS del bulk add (orden importa: el bulk puede dejar el total stale).
    const paths = h.post.mock.calls.map((c) => c[0]);
    expect(paths.indexOf('/orders/CLOVER-1')).toBeGreaterThan(paths.indexOf('/orders/CLOVER-1/bulk_line_items'));
  });

  it('does NOT set order.total on a paid primary with no delta (no_delta_paid)', async () => {
    // Paid primary + the frozen items already match what's billed on Clover →
    // nothing to supplement; no order.total POST.
    h.cloverState = { clover_ticket_id: 'CLOVER-1', clover_line_items_hash: 'H1' };
    h.get.mockResolvedValue({
      data: { lineItems: { elements: [{ id: 'li1', name: 'Burger' }] }, payments: { elements: [{ id: 'p1' }] } },
    });
    const out = await reconcile({
      stepInput: {},
      jobPayload: { order_id: 5, line_items: lineItems, line_items_hash: 'H2', order_total_cents: 1105 },
      context: { create_order: { clover_order_id: 'CLOVER-1' } },
      job,
      step,
    });
    expect(out).toMatchObject({ skipped: 'no_delta_paid' });
    expect(h.post).not.toHaveBeenCalledWith('/orders/CLOVER-1', { total: 1105 });
  });

  // Paid primary + no delta → never mutate the paid order; persist the hash so the
  // recurring push stops re-triggering. (Supplemental-on-delta is covered in
  // clover-supplemental.test.ts.)
  it('no_delta_paid: does not mutate the paid order and persists the hash', async () => {
    h.cloverState = { clover_ticket_id: 'CLOVER-1', clover_line_items_hash: 'H1' };
    h.get.mockResolvedValue({
      data: { lineItems: { elements: [{ id: 'li1', name: 'Burger' }] }, payments: { elements: [{ id: 'p1' }] } },
    });
    const out = await run();
    expect(out).toMatchObject({ skipped: 'no_delta_paid' });
    expect(h.del).not.toHaveBeenCalled();
    expect(h.orderUpdates.some((u) => 'clover_line_items_hash' in u)).toBe(true);
  });

  it('fails non-retryable when exceeding the 3000 line-item limit', async () => {
    const many = Array.from({ length: 3001 }, () => ({ name: 'x', price: 1 }));
    await expect(run(many)).rejects.toMatchObject({ code: 'CLOVER_TOO_MANY_LINE_ITEMS', retryable: false });
    expect(h.get).not.toHaveBeenCalled();
  });
});
