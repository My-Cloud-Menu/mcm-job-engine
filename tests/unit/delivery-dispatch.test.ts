import { vi, describe, it, expect, beforeEach } from 'vitest';

// Auditoría delivery 2026-06-22 — handler delivery.dispatch (job-engine).
// Reusa la edge fn delivery-create; aquí verificamos clasificación retryable/fatal + payload.

vi.mock('../../src/config', () => ({
  config: { supabase: { url: 'http://edge.test', serviceRoleKey: 'srk-test' } },
}));
vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn() }) },
}));

import '../../src/handlers/delivery/dispatch';
import { getHandler } from '../../src/handlers/registry';
import { HandlerError } from '../../src/core/types';

const handler = getHandler('delivery', 'dispatch')!;
const job = { id: 'job-d1', site_id: 55126712 } as any;
const step = { idempotency_key: 'delivery_dispatch:55126712:10588:dispatch', attempt_count: 0, max_attempts: 5 } as any;

function run(extra: Record<string, unknown> = {}) {
  return handler({
    stepInput: {},
    jobPayload: { site_id: 55126712, order_id: 10588, test: true, ...extra },
    context: {},
    job,
    step,
  });
}

function mockFetch(impl: () => Promise<any>) {
  // @ts-expect-error test stub
  global.fetch = vi.fn(impl);
}

describe('delivery.dispatch handler', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('handler está registrado', () => {
    expect(typeof handler).toBe('function');
  });

  it('2xx limpio → devuelve delivery_id/status y llama delivery-create con el payload correcto', async () => {
    mockFetch(async () => ({ ok: true, status: 201, json: async () => ({ delivery: { id: 'del_1', status: 'pending' }, idempotent: false }) }));
    const out = await run();
    expect(out).toMatchObject({ delivery_id: 'del_1', status: 'pending', idempotent: false });
    const [url, opts] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('http://edge.test/functions/v1/delivery-create');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ site_id: 55126712, order_id: 10588, test: true });
    expect(opts.headers.Authorization).toBe('Bearer srk-test');
  });

  it('body.dispatch_error en 2xx → HandlerError RETRYABLE (engine reintenta)', async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ delivery: { id: 'del_2', status: 'pending' }, dispatch_error: 'no_courier' }) }));
    await expect(run()).rejects.toMatchObject({ name: 'HandlerError', retryable: true, code: 'DELIVERY_DISPATCH_ERROR' });
  });

  it('HTTP 500 → retryable', async () => {
    mockFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(HandlerError);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(500);
  });

  it('HTTP 429/408 → retryable', async () => {
    mockFetch(async () => ({ ok: false, status: 429, json: async () => ({ error: 'rate' }) }));
    expect((await run().catch((e) => e)).retryable).toBe(true);
  });

  it('HTTP 4xx (400/404/409) → FATAL (dead-letter)', async () => {
    mockFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad_request' }) }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(HandlerError);
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(400);
  });

  it('error de red/timeout → retryable (DELIVERY_NETWORK)', async () => {
    mockFetch(async () => { throw new Error('ECONNRESET'); });
    await expect(run()).rejects.toMatchObject({ name: 'HandlerError', retryable: true, code: 'DELIVERY_NETWORK' });
  });

  it('test default false cuando no se envía', async () => {
    mockFetch(async () => ({ ok: true, status: 201, json: async () => ({ delivery: { id: 'del_3', status: 'pending' } }) }));
    await run({ test: undefined });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.test).toBe(false);
  });
});
