import { vi, describe, it, expect, beforeEach } from 'vitest';

// Hoisted mock fns so the vi.mock factories can reference them.
const h = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  orderUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/handlers/omnivore/client', () => ({
  createOmnivoreClient: () => ({ post: h.post, get: h.get }),
  OmnivoreConfigSchema: { parse: (c: unknown) => c },
}));

vi.mock('../../src/lib/credentials', () => ({
  getSiteIntegrationConfig: vi.fn(async () => ({
    config: { apiKey: 'k', omnivoreId: 'LOC' },
    integrationId: 'int-1',
  })),
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn() }) },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        h.orderUpdates.push(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
  },
}));

// Importing the handler registers it.
import '../../src/handlers/omnivore/inject/create-order';
import { getHandler } from '../../src/handlers/registry';
import { HandlerError } from '../../src/core/types';

const handler = getHandler('omnivore', 'create_order')!;

const job = { id: 'job-1', site_id: 25, correlation_id: 'corr-1' } as any;
const step = { idempotency_key: 'pos_inject:omnivore:123:create_order', attempt_count: 0, max_attempts: 3 } as any;
const ticket = { employee: '200', order_type: '5', revenue_center: '1', name: 'MCM 123', auto_send: true };

function run(extra: Record<string, unknown> = {}) {
  return handler({
    stepInput: {},
    jobPayload: { order_id: 123, ticket, items: [], payments: [], ...extra },
    context: {},
    job,
    step,
  });
}

describe('omnivore create_order handler', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.get.mockReset();
    h.orderUpdates.length = 0;
  });

  it('opens the ticket, sends Idempotency-Id, and persists omnivore_pos_id', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } }); // dedup lookup: none
    h.post.mockResolvedValue({ data: { id: 'TICKET-9', ticket_number: 42 }, status: 201 });

    const out = await run();

    expect(out).toMatchObject({ omnivore_ticket_id: 'TICKET-9', ticket_number: 42 });
    // posted the exact pre-built ticket body
    expect(h.post).toHaveBeenCalledWith('/tickets', ticket, expect.anything());
    // sent the stable Idempotency-Id (the -Id header, not -Key)
    const headers = h.post.mock.calls[0][2].headers;
    expect(headers['Idempotency-Id']).toBe('pos_inject:omnivore:123:create_order');
    // persisted ticket id + cleared error
    expect(h.orderUpdates[0]).toMatchObject({
      omnivore_pos_id: 'TICKET-9',
      pos_id: 'TICKET-9',
      global_pos_id: '25-TICKET-9',
      pos_injection_error: null,
    });
  });

  it('adopts an existing open ticket by name without re-posting (dedup/resume)', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [{ id: 'TICKET-EXISTING' }] } } });

    const out = await run();

    expect(out).toMatchObject({ omnivore_ticket_id: 'TICKET-EXISTING', adopted: true });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.orderUpdates[0]).toMatchObject({ omnivore_pos_id: 'TICKET-EXISTING' });
  });

  it('skips the name dedup when the name is not order-unique', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [{ id: 'WRONG' }] } } });
    h.post.mockResolvedValue({ data: { id: 'TICKET-NEW' }, status: 201 });

    // Site-414341196-style name without the order id → guard must be skipped.
    const out = await run({ ticket: { ...ticket, name: 'MCM-Jane D' } });

    expect(out).toMatchObject({ omnivore_ticket_id: 'TICKET-NEW' });
    expect(h.post).toHaveBeenCalled();
  });

  it('throws non-retryable on a business slug and records pos_injection_error', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { tickets: [] } } });
    h.post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { errors: [{ error: 'reference_not_found', description: 'bad menu item' }] } },
    });

    await expect(run()).rejects.toBeInstanceOf(HandlerError);
    // pos_injection_error written because the step will dead-letter (retryable=false)
    const errUpdate = h.orderUpdates.find((u) => 'pos_injection_error' in u && u.pos_injection_error !== null);
    expect(errUpdate).toBeTruthy();
  });
});
