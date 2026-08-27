import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  existingPosId: null as string | null,
  paymentUpdates: [] as any[],
  mapUpserts: [] as any[],
  orderUpdates: [] as any[],
}));

vi.mock('../../src/handlers/clover/client', () => ({
  createCloverClient: () => ({ post: h.post }),
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
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.existingPosId ? { pos_id: h.existingPosId } : null }) }) }),
      }),
      update: (patch: any) => {
        (table === 'payments' ? h.paymentUpdates : h.orderUpdates).push(patch);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
      upsert: (row: any) => {
        h.mapUpserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  },
}));

import '../../src/handlers/clover/inject/payment';
import { getHandler } from '../../src/handlers/registry';
import { HandlerError } from '../../src/core/types';

const handler = getHandler('clover', 'payment_injection')!;
const job = { id: 'job-1', site_id: 25, correlation_id: 'c' } as any;
const step = { idempotency_key: 'clover_pay:55:apply', attempt_count: 0, max_attempts: 5 } as any;
const payment = { amount: 2000, tipAmount: 0, tender: { id: 'T1' }, externalPaymentId: 'Invoice #: 7' };

function run() {
  return handler({
    stepInput: {},
    jobPayload: { payment_id: 55, order_id: 123, ticket_id: 'CLOVER-9', payment, external_payment_id: 'Invoice #: 7' },
    context: {},
    job,
    step,
  });
}

describe('clover payment_injection handler', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.existingPosId = null;
    h.paymentUpdates.length = 0;
    h.mapUpserts.length = 0;
    h.orderUpdates.length = 0;
  });

  it('applies the payment, persists pos_id and records clover_payment_map', async () => {
    h.post.mockResolvedValue({ data: { id: 'CPAY-1' } });
    const out = await run();
    expect(out).toMatchObject({ clover_payment_id: 'CPAY-1' });
    // El POST lleva el 3er arg con la cabecera Idempotency-Key (que Clover IGNORA — medido,
    // H-N7 — pero se conserva por si algún día la implementa) y el cuerpo ahora incluye el
    // ancla `note`, que es la protección REAL contra el cobro doble: el reconcile-before-repost
    // busca por ese `note` antes de re-postear en un reintento.
    expect(h.post).toHaveBeenCalledWith(
      '/orders/CLOVER-9/payments',
      { ...payment, note: 'mcm:pay:25:55' },
      expect.objectContaining({ headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }) }),
    );
    expect(h.paymentUpdates.find((u) => u.pos_id === 'CPAY-1')).toBeTruthy();
    const map = h.mapUpserts[0];
    expect(map).toMatchObject({ clover_payment_id: 'CPAY-1', mcm_payment_id: 55, external_payment_id: 'Invoice #: 7' });
  });

  it('skips when the MCM payment already has a pos_id (resume guard)', async () => {
    h.existingPosId = 'ALREADY';
    const out = await run();
    expect(out).toMatchObject({ skipped: 'already_applied', clover_payment_id: 'ALREADY' });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('business error → non-retryable HandlerError + pos_injection_error', async () => {
    h.post.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { message: 'bad tender' } } });
    await expect(run()).rejects.toBeInstanceOf(HandlerError);
    expect(h.orderUpdates.find((u) => u.pos_injection_error)).toBeTruthy();
  });
});
