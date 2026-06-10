import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), orderUpdates: [] as any[] }));

vi.mock('../../src/handlers/omnivore/client', () => ({
  createOmnivoreClient: () => ({ post: h.post, get: h.get }),
  OmnivoreConfigSchema: { parse: (c: unknown) => c },
}));
vi.mock('../../src/lib/credentials', () => ({
  getSiteIntegrationConfig: vi.fn(async () => ({ config: { apiKey: 'k', omnivoreId: 'L' }, integrationId: 'i' })),
}));
vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn() }) },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      update: (patch: any) => {
        h.orderUpdates.push(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
  },
}));

import '../../src/handlers/omnivore/inject/create-payment';
import { getHandler } from '../../src/handlers/registry';
import { HandlerError } from '../../src/core/types';

const handler = getHandler('omnivore', 'create_payment')!;
const job = { id: 'job-1', site_id: 25, correlation_id: 'c' } as any;
const step = { idempotency_key: 'pos_inject:omnivore:123:create_payment', attempt_count: 0, max_attempts: 5 } as any;
// New contract: amount (charged amount, cents), NOT full:true.
const payments = [{ type: '3rd_party', tender_type: '102', tip: 0, amount: 2000 }];

function run() {
  return handler({
    stepInput: {},
    jobPayload: { order_id: 123, payments },
    context: { create_order: { omnivore_ticket_id: 'TICKET-1' } },
    job,
    step,
  });
}

describe('omnivore create_payment handler', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.get.mockReset();
    h.orderUpdates.length = 0;
  });

  it('posts the payment (with amount, not full) when there is a balance due', async () => {
    h.get.mockResolvedValue({ data: { totals: { due: 2000, paid: 0 }, _embedded: { payments: [] } } });
    h.post.mockResolvedValue({ data: { id: 'PAY-1' } });

    const out = await run();

    expect(out).toMatchObject({ applied: 1 });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-1/payments', payments[0], expect.anything());
    const body = h.post.mock.calls[0][1];
    expect(body.amount).toBe(2000);
    expect(body).not.toHaveProperty('full');
  });

  it('skips when the ticket balance is already 0 (resume guard)', async () => {
    h.get.mockResolvedValue({ data: { totals: { due: 0, paid: 2000 }, _embedded: { payments: [{ id: 'p' }] } } });

    const out = await run();

    expect(out).toMatchObject({ skipped: 'already_paid' });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('business error → non-retryable HandlerError and records pos_injection_error', async () => {
    h.get.mockResolvedValue({ data: { totals: { due: 2000, paid: 0 }, _embedded: { payments: [] } } });
    h.post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { errors: [{ error: 'excessive_payment', description: 'too much' }] } },
    });

    await expect(run()).rejects.toBeInstanceOf(HandlerError);
    const errUpdate = h.orderUpdates.find((u) => 'pos_injection_error' in u && u.pos_injection_error);
    expect(errUpdate).toBeTruthy();
  });
});
