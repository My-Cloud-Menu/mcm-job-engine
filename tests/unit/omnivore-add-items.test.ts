import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  getConfig: vi.fn(),
  state: {
    order: { status: 'in-kitchen', pos_injection_error: null } as Record<string, unknown> | null,
    orderReadError: null as { message: string } | null,
    writeError: null as { message: string } | null,
    calls: [] as Array<{ table: string; op: string; patch?: Record<string, unknown>; filters: unknown[] }>,
    timeline: [] as string[],
  },
}));

vi.mock('../../src/handlers/omnivore/client', () => ({
  createOmnivoreClient: () => ({ post: h.post, get: h.get }),
  OmnivoreConfigSchema: { parse: (c: unknown) => c },
}));
vi.mock('../../src/lib/credentials', () => ({ getSiteIntegrationConfig: h.getConfig }));
vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn() }) },
}));
vi.mock('../../src/lib/supabase', async () => {
  const m = await import('./helpers/fake-supabase');
  return { supabase: m.makeFakeSupabase(h.state as never) };
});

import '../../src/handlers/omnivore/inject/add-items';
import { getHandler } from '../../src/handlers/registry';
import { statusWrites } from './helpers/fake-supabase';

const handler = getHandler('omnivore', 'add_items')!;
const job = { id: 'job-1', site_id: 25, correlation_id: 'corr-1' } as any;
const items = [
  { menu_item: '1001', quantity: 1 },
  { menu_item: '1002', quantity: 2 },
  { menu_item: '1003', quantity: 1 },
];

function run(context: Record<string, unknown> = { create_order: { omnivore_ticket_id: 'TICKET-1' } }, attempt = 0) {
  return handler({
    stepInput: {},
    jobPayload: { order_id: 123, items },
    context,
    job,
    step: { idempotency_key: 'pos_inject:omnivore:25:123:add_items', attempt_count: attempt, max_attempts: 5 } as any,
  });
}

describe('omnivore add_items handler', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.get.mockReset();
    h.getConfig.mockReset();
    h.getConfig.mockResolvedValue({ config: { apiKey: 'k', omnivoreId: 'LOC' }, integrationId: 'int-1', locationId: null });
    h.state.order = { status: 'in-kitchen', pos_injection_error: null };
    h.state.orderReadError = null;
    h.state.calls.length = 0;
    h.state.timeline.length = 0;
  });

  it('posts the batched items with Idempotency-Id when the ticket is empty', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { items: [] } } });
    h.post.mockResolvedValue({ data: { id: 'x' } });

    const out = await run();

    expect(out).toMatchObject({ added: 3 });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-1/items', { items }, expect.anything());
    expect(h.post.mock.calls[0][2].headers['Idempotency-Id']).toBe('pos_inject:omnivore:25:123:add_items');
  });

  it('skips when the ticket already has all the items (a prior attempt landed them)', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } } });
    const out = await run({ create_order: { omnivore_ticket_id: 'TICKET-1' } }, 1);
    expect(out).toMatchObject({ skipped: 'already_present', existing: 3 });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('half-loaded ticket: never re-posts (would duplicate), marks needs_action ITEMS_PARTIAL with a retry option', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { items: [{ id: 'a' }] } } });

    const err = await run({ create_order: { omnivore_ticket_id: 'TICKET-1' } }, 1).catch((e) => e);

    expect(err.code).toBe('ITEMS_PARTIAL');
    expect(err.retryable).toBe(false);
    expect(h.post).not.toHaveBeenCalled();
    const writes = statusWrites(h.state as never);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ state: 'needs_action', step: 'add_items', code: 'ITEMS_PARTIAL', ticket_id: 'TICKET-1', can_retry: true });
    expect(String(writes[0]!['detail'])).toMatch(/1 de 3/);
  });

  it('order cancelled in MCM after the ticket exists: stops and asks to void it in the POS', async () => {
    h.state.order = { status: 'trash', pos_injection_error: null };
    const out = await run();
    expect(out).toMatchObject({ skipped: 'order_cancelled_with_ticket' });
    expect(h.post).not.toHaveBeenCalled();
    expect(statusWrites(h.state as never)[0]).toMatchObject({ state: 'needs_action', code: 'ORDER_CANCELLED_WITH_TICKET', can_retry: false });
  });

  it('step 1 skipped (cancelled/resolved): nothing to do, no reads', async () => {
    const out = await run({ create_order: { skipped: 'order_cancelled' } });
    expect(out).toMatchObject({ skipped: 'upstream_skipped' });
    expect(h.get).not.toHaveBeenCalled();
  });

  it('transient failure: status `retrying` with the ticket id', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { items: [] } } });
    h.post.mockRejectedValue({ isAxiosError: true, response: { status: 504, data: {} } });
    const err = await run().catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ state: 'retrying', step: 'add_items', code: 'HTTP_504', ticket_id: 'TICKET-1', attempt: 1, max_attempts: 5 });
  });

  it('fails (non-retryable) when ticket id is missing from context, and says so on the order', async () => {
    await expect(run({})).rejects.toMatchObject({ code: 'MISSING_CONTEXT' });
    expect(h.post).not.toHaveBeenCalled();
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ state: 'failed', code: 'MISSING_CONTEXT' });
  });
});
