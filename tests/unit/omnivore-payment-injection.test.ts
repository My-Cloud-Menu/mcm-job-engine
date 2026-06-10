import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  existingPosId: null as string | null,
  existingAdditionalProps: null as Record<string, unknown> | null,
  paymentUpdates: [] as any[],
}));

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
    from: (table: string) => ({
      // payments.select('pos_id' | 'additional_properties').eq().eq().maybeSingle()
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { pos_id: h.existingPosId, additional_properties: h.existingAdditionalProps },
            }),
          }),
        }),
      }),
      // payments.update({pos_id}).eq().eq()  | orders.update({issues}).eq().eq()
      update: (patch: any) => {
        h.paymentUpdates.push({ table, patch });
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
  },
}));

import '../../src/handlers/omnivore/inject/payment';
import { getHandler } from '../../src/handlers/registry';

const handler = getHandler('omnivore', 'payment_injection')!;
const job = { id: 'job-1', site_id: 25, correlation_id: 'c' } as any;
const step = { idempotency_key: 'pos_pay:omnivore:55:apply', attempt_count: 0, max_attempts: 5 } as any;
const payment = { type: '3rd_party', tender_type: '102', tip: 0, amount: 2000, comment: 'Invoice #: 7' };

function run() {
  return handler({
    stepInput: {},
    jobPayload: { payment_id: 55, order_id: 123, ticket_id: 'TICKET-9', payment },
    context: {},
    job,
    step,
  });
}

describe('omnivore payment_injection handler', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.get.mockReset();
    h.existingPosId = null;
    h.existingAdditionalProps = null;
    h.paymentUpdates.length = 0;
  });

  it('applies the payment and persists payments.pos_id', async () => {
    h.post.mockResolvedValue({ data: { id: 'OMNI-PAY-1' } });

    const out = await run();

    expect(out).toMatchObject({ omnivore_payment_id: 'OMNI-PAY-1' });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-9/payments', payment, expect.anything());
    const upd = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.pos_id === 'OMNI-PAY-1');
    expect(upd).toBeTruthy();
  });

  it('skips when the MCM payment already has a pos_id (resume guard)', async () => {
    h.existingPosId = 'ALREADY';

    const out = await run();

    expect(out).toMatchObject({ skipped: 'already_applied', omnivore_payment_id: 'ALREADY' });
    expect(h.post).not.toHaveBeenCalled();
  });

  // Clover-pull forward: pos_id holds the CLOVER payment id, so the marker must
  // be read/written under additional_properties.omnivore_payment_id instead.
  function runWithMarker() {
    return handler({
      stepInput: {},
      jobPayload: {
        payment_id: 55,
        order_id: 123,
        ticket_id: 'TICKET-9',
        payment,
        pos_id_field: 'additional_properties.omnivore_payment_id',
      },
      context: {},
      job,
      step,
    });
  }

  it('marker mode: ignores pos_id (Clover id), applies, and writes additional_properties marker', async () => {
    h.existingPosId = 'CLOVER-PAY'; // must NOT count as applied-to-Omnivore
    h.existingAdditionalProps = {};
    h.post.mockResolvedValue({ data: { id: 'OMNI-PAY-2' } });

    const out = await runWithMarker();

    expect(out).toMatchObject({ omnivore_payment_id: 'OMNI-PAY-2' });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-9/payments', payment, expect.anything());
    const upd = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.additional_properties);
    expect(upd.patch.additional_properties).toMatchObject({ omnivore_payment_id: 'OMNI-PAY-2' });
    // Must NOT have written pos_id (that belongs to Clover here).
    expect(h.paymentUpdates.find((u) => u.patch.pos_id)).toBeUndefined();
  });

  it('marker mode: skips when the additional_properties marker is already set (resume guard)', async () => {
    h.existingAdditionalProps = { omnivore_payment_id: 'ALREADY-OMNI' };

    const out = await runWithMarker();

    expect(out).toMatchObject({ skipped: 'already_applied', omnivore_payment_id: 'ALREADY-OMNI' });
    expect(h.post).not.toHaveBeenCalled();
  });
});
