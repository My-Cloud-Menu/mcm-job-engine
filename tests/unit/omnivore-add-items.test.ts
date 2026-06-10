import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));

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
  supabase: { from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) },
}));

import '../../src/handlers/omnivore/inject/add-items';
import { getHandler } from '../../src/handlers/registry';

const handler = getHandler('omnivore', 'add_items')!;
const job = { id: 'job-1', site_id: 25, correlation_id: 'c' } as any;
const step = { idempotency_key: 'pos_inject:omnivore:123:add_items', attempt_count: 0, max_attempts: 5 } as any;
const items = [{ menu_item: '208', quantity: 2, price_level: 'i0', modifiers: [] }];

function run(ctxTicketId: string | undefined = 'TICKET-1') {
  return handler({
    stepInput: {},
    jobPayload: { order_id: 123, items },
    context: ctxTicketId ? { create_order: { omnivore_ticket_id: ctxTicketId } } : {},
    job,
    step,
  });
}

describe('omnivore add_items handler', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.get.mockReset();
  });

  it('posts the batched items with Idempotency-Id when the ticket is empty', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { items: [] } } });
    h.post.mockResolvedValue({ data: { id: 'x' } });

    const out = await run();

    expect(out).toMatchObject({ added: 1 });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-1/items', { items }, expect.anything());
    expect(h.post.mock.calls[0][2].headers['Idempotency-Id']).toBe('pos_inject:omnivore:123:add_items');
  });

  it('skips posting when the ticket already has items (resume guard)', async () => {
    h.get.mockResolvedValue({ data: { _embedded: { items: [{ id: 'a' }] } } });

    const out = await run();

    expect(out).toMatchObject({ skipped: 'already_present' });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('fails (non-retryable) when ticket id is missing from context', async () => {
    await expect(
      handler({ stepInput: {}, jobPayload: { order_id: 123, items }, context: {}, job, step })
    ).rejects.toMatchObject({ code: 'MISSING_CONTEXT' });
    expect(h.post).not.toHaveBeenCalled();
  });
});
