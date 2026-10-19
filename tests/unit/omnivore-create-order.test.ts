import { vi, describe, it, expect, beforeEach } from 'vitest';

// Hoisted state shared by the mock factories.
const h = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  getConfig: vi.fn(),
  clientConfigs: [] as Array<Record<string, unknown>>,
  state: {
    order: { status: 'in-kitchen', pos_injection_error: null } as Record<string, unknown> | null,
    orderReadError: null as { message: string } | null,
    writeError: null as { message: string } | null,
    calls: [] as Array<{ table: string; op: string; patch?: Record<string, unknown>; filters: unknown[] }>,
    timeline: [] as string[],
  },
}));

vi.mock('../../src/handlers/omnivore/client', () => ({
  createOmnivoreClient: (cfg: Record<string, unknown>) => {
    h.clientConfigs.push(cfg);
    return {
      post: (...a: unknown[]) => {
        h.state.timeline.push(`post:${a[0]}`);
        return h.post(...a);
      },
      get: h.get,
    };
  },
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

// Importing the handler registers it.
import '../../src/handlers/omnivore/inject/create-order';
import { CREATE_ORDER_ATTEMPT_MARKER } from '../../src/handlers/omnivore/inject/create-order';
import { getHandler } from '../../src/handlers/registry';
import { HandlerError } from '../../src/core/types';
import { statusWrites } from './helpers/fake-supabase';

const handler = getHandler('omnivore', 'create_order')!;

const job = { id: 'job-1', site_id: 25, correlation_id: 'corr-1' } as any;
const ticket = { employee: '200', order_type: '5', revenue_center: '1', name: 'MCM 123', auto_send: true };

function run(opts: { extra?: Record<string, unknown>; context?: Record<string, unknown>; attempt?: number } = {}) {
  return handler({
    stepInput: {},
    jobPayload: { order_id: 123, ticket, items: [], payments: [], ...(opts.extra ?? {}) },
    context: opts.context ?? {},
    job,
    step: { idempotency_key: 'pos_inject:omnivore:25:123:create_order', attempt_count: opts.attempt ?? 0, max_attempts: 3 } as any,
  });
}

const ticketUpdates = () =>
  h.state.calls.filter((c) => c.table === 'orders' && c.op === 'update' && c.patch && 'omnivore_pos_id' in c.patch);
const markerWrites = () => h.state.calls.filter((c) => c.table === 'integration_jobs' && c.op === 'update');

describe('omnivore create_order handler', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.get.mockReset();
    h.getConfig.mockReset();
    h.getConfig.mockResolvedValue({ config: { apiKey: 'k', omnivoreId: 'LOC' }, integrationId: 'int-1', locationId: null });
    h.clientConfigs.length = 0;
    h.state.order = { status: 'in-kitchen', pos_injection_error: null };
    h.state.orderReadError = null;
    h.state.writeError = null;
    h.state.calls.length = 0;
    h.state.timeline.length = 0;
  });

  it('first attempt: saves the attempt marker BEFORE posting, posts with Idempotency-Id and persists the ticket', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } }); // eq(name) lookup: none
    h.post.mockResolvedValue({ data: { id: 'TICKET-9', ticket_number: 42 }, status: 201 });

    const out = await run();

    expect(out).toMatchObject({ omnivore_ticket_id: 'TICKET-9', ticket_number: 42 });
    expect(h.post).toHaveBeenCalledWith('/tickets', ticket, expect.anything());
    expect(h.post.mock.calls[0][2].headers['Idempotency-Id']).toBe('pos_inject:omnivore:25:123:create_order');
    // marker first, then the POST
    expect(h.state.timeline.indexOf('update:integration_jobs')).toBeGreaterThanOrEqual(0);
    expect(h.state.timeline.indexOf('update:integration_jobs')).toBeLessThan(h.state.timeline.indexOf('post:/tickets'));
    expect(markerWrites()[0]!.patch!['context']).toHaveProperty(CREATE_ORDER_ATTEMPT_MARKER);
    // only one GET: no full scan on a clean first attempt
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(ticketUpdates()[0]!.patch).toMatchObject({ omnivore_pos_id: 'TICKET-9', pos_id: 'TICKET-9', global_pos_id: '25-TICKET-9', pos_injection_error: null });
    // every order write carries site_id
    for (const c of h.state.calls.filter((x) => x.table === 'orders')) {
      expect(c.filters).toContainEqual(['eq', 'site_id', 25]);
    }
  });

  it('legacy payload (no seal) resolves the connection exactly like before (no scope)', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } });
    h.post.mockResolvedValue({ data: { id: 'T' }, status: 201 });
    await run();
    expect(h.getConfig).toHaveBeenCalledWith(25, 'omnivore', 'pos', undefined);
    expect(h.clientConfigs[0]).toEqual({ apiKey: 'k', omnivoreId: 'LOC' });
  });

  it('sealed payload: resolves by integration_id and always targets the sealed omnivore_id', async () => {
    h.getConfig.mockResolvedValue({ config: { apiKey: 'k', omnivoreId: 'CHANGED' }, integrationId: 'int-7', locationId: '71000002' });
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } });
    h.post.mockResolvedValue({ data: { id: 'T' }, status: 201 });

    await run({ extra: { integration_id: 'int-7', location_id: '71000002', omnivore_id: 'SEALED' } });

    expect(h.getConfig).toHaveBeenCalledWith(25, 'omnivore', 'pos', { integrationId: 'int-7' });
    expect(h.clientConfigs[0]).toMatchObject({ omnivoreId: 'SEALED' });
  });

  it('K1: business connection (live sites) does not write pos_location_id (stays 0, exactly as before)', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } });
    h.post.mockResolvedValue({ data: { id: 'T1' }, status: 201 });
    await run();
    expect(ticketUpdates()[0]!.patch).not.toHaveProperty('pos_location_id');
  });

  it('K1: a sealed location connection stores the ticket under its location', async () => {
    h.getConfig.mockResolvedValue({ config: { apiKey: 'k', omnivoreId: 'L2' }, integrationId: 'int-7', locationId: '71000002' });
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } });
    h.post.mockResolvedValue({ data: { id: 'T2' }, status: 201 });
    await run({ extra: { integration_id: 'int-7', location_id: '71000002', omnivore_id: 'L2' } });
    expect(ticketUpdates()[0]!.patch).toMatchObject({ omnivore_pos_id: 'T2', pos_location_id: 71000002 });
  });

  it('ticket created but not linked to the order: retryable TICKET_LINK_FAILED (the retry adopts it by name)', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } });
    h.post.mockImplementation(async () => {
      h.state.writeError = { message: 'db down' }; // la base cae justo después de crear el ticket
      return { data: { id: 'T3' }, status: 201 };
    });
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({ code: 'TICKET_LINK_FAILED', retryable: true });
    h.state.writeError = null;
  });

  it('retry after a dead-letter (attempt_count reset to 0) with the marker present: scans ALL pages and adopts', async () => {
    h.get
      .mockResolvedValueOnce({ data: { _embedded: { tickets: [] } } }) // eq(name): Aloha returns nothing
      .mockResolvedValueOnce({
        data: { _embedded: { tickets: [{ id: 'A', name: 'MCM 1' }] }, _links: { next: { href: 'https://next/page2' } } },
      })
      .mockResolvedValueOnce({ data: { _embedded: { tickets: [{ id: 'TICKET-EXISTING', name: 'MCM 123' }] } } });

    const out = await run({ context: { [CREATE_ORDER_ATTEMPT_MARKER]: '2026-10-18T00:00:00Z' }, attempt: 0 });

    expect(out).toMatchObject({ omnivore_ticket_id: 'TICKET-EXISTING', adopted: true });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.get.mock.calls[2][0]).toBe('https://next/page2');
    expect(ticketUpdates()[0]!.patch).toMatchObject({ omnivore_pos_id: 'TICKET-EXISTING' });
  });

  it('forced re-send (scan_existing) on a first attempt still scans and adopts instead of opening a second ticket', async () => {
    h.get
      .mockResolvedValueOnce({ data: { _embedded: { tickets: [] } } })
      .mockResolvedValueOnce({ data: { _embedded: { tickets: [{ id: 'OLD', name: 'MCM 123' }] } } });
    const out = await run({ extra: { scan_existing: true } });
    expect(out).toMatchObject({ omnivore_ticket_id: 'OLD', adopted: true });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('if the check for an existing ticket fails it does NOT create blind: retryable TICKET_SEARCH_FAILED', async () => {
    h.get
      .mockResolvedValueOnce({ data: { _embedded: { tickets: [] } } })
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 503, data: {} } });

    const err = await run({ attempt: 1 }).catch((e) => e);

    expect(err).toBeInstanceOf(HandlerError);
    expect(err.code).toBe('TICKET_SEARCH_FAILED');
    expect(err.retryable).toBe(true);
    expect(h.post).not.toHaveBeenCalled();
    const st = statusWrites(h.state as never).at(-1)!;
    expect(st).toMatchObject({ state: 'retrying', step: 'create_order', code: 'TICKET_SEARCH_FAILED', attempt: 2, max_attempts: 3, can_retry: false });
  });

  it('does not inject a cancelled order (Q5)', async () => {
    h.state.order = { status: 'cancelled', pos_injection_error: null };
    const out = await run();
    expect(out).toMatchObject({ skipped: 'order_cancelled' });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('does not touch an order the staff resolved by hand', async () => {
    h.state.order = { status: 'in-kitchen', pos_injection_error: { state: 'resolved', resolved_by: 'Ana' } };
    const out = await run();
    expect(out).toMatchObject({ skipped: 'resolved_manually' });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('a failed order read retries (never injects a possibly-cancelled order blind)', async () => {
    h.state.orderReadError = { message: 'timeout' };
    const err = await run().catch((e) => e);
    expect(err.code).toBe('ORDER_READ_FAILED');
    expect(err.retryable).toBe(true);
    expect(h.post).not.toHaveBeenCalled();
  });

  it('skips the name dedup when the name does not identify the order', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [{ id: 'WRONG' }] } } });
    h.post.mockResolvedValue({ data: { id: 'TICKET-NEW' }, status: 201 });

    const out = await run({ extra: { ticket: { ...ticket, name: 'MCM-Jane D' } }, attempt: 1 });

    expect(out).toMatchObject({ omnivore_ticket_id: 'TICKET-NEW' });
    expect(h.get).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalled();
  });

  it('business error: non-retryable, status `failed` with the staff message, the step and the raw Omnivore errors', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } });
    h.post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { errors: [{ error: 'reference_not_found', description: 'bad menu item' }] } },
    });

    await expect(run()).rejects.toBeInstanceOf(HandlerError);
    const st = statusWrites(h.state as never).at(-1)!;
    expect(st).toMatchObject({
      state: 'failed',
      step: 'create_order',
      code: 'OMNIVORE_REFERENCE_NOT_FOUND',
      can_retry: true,
      attempt: 1,
      max_attempts: 3,
    });
    expect(String(st['message'])).toMatch(/no existe en el POS/);
    expect(st['errors']).toEqual([{ error: 'reference_not_found', description: 'bad menu item' }]);
    // the write never overwrites a manually resolved order
    const w = h.state.calls.find((c) => c.table === 'orders' && c.patch && (c.patch as any).pos_injection_error?.state === 'failed')!;
    expect(w.filters.find((f) => (f as unknown[])[0] === 'or')).toBeTruthy();
  });

  it('transient error with attempts left: status `retrying` (attempt n of max)', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } });
    h.post.mockRejectedValue({ isAxiosError: true, response: { status: 503, data: { errors: [{ error: 'pos_offline', description: 'offline' }] } } });

    const err = await run().catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ state: 'retrying', code: 'OMNIVORE_POS_OFFLINE', attempt: 1, max_attempts: 3, can_retry: false });
  });

  it('a config/credentials failure is also stored on the order (R3)', async () => {
    h.getConfig.mockRejectedValue(new HandlerError('No active integration', 'NO_INTEGRATION', false));
    await expect(run()).rejects.toBeInstanceOf(HandlerError);
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ state: 'failed', step: 'create_order', code: 'NO_INTEGRATION' });
  });
});
