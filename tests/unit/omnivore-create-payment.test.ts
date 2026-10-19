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

import '../../src/handlers/omnivore/inject/create-payment';
import { capPaymentsToDue } from '../../src/handlers/omnivore/inject/create-payment';
import { getHandler } from '../../src/handlers/registry';
import { HandlerError } from '../../src/core/types';
import { statusWrites } from './helpers/fake-supabase';

const handler = getHandler('omnivore', 'create_payment')!;
const job = { id: 'job-1', site_id: 25, correlation_id: 'corr-1' } as any;
const payments = [{ type: '3rd_party', tender_type: '107', amount: 2000, tip: 300 }];

const totals = (due: number | null, paid: number, n: number) => ({
  data: { totals: { due, paid }, _embedded: { payments: Array.from({ length: n }, (_, i) => ({ id: `p${i}` })) } },
});

function run(opts: { payload?: Record<string, unknown>; context?: Record<string, unknown>; attempt?: number; max?: number } = {}) {
  return handler({
    stepInput: {},
    jobPayload: { order_id: 123, payments, ...(opts.payload ?? {}) },
    context: opts.context ?? { create_order: { omnivore_ticket_id: 'TICKET-1' }, add_items: { added: 1 } },
    job,
    step: { idempotency_key: 'pos_inject:omnivore:25:123:create_payment', attempt_count: opts.attempt ?? 0, max_attempts: opts.max ?? 5 } as any,
  });
}

const notes = () => h.state.calls.filter((c) => c.table === 'order_notes' && c.op === 'insert');

describe('capPaymentsToDue (pure)', () => {
  it('leaves payments that fit untouched', () => {
    expect(capPaymentsToDue([{ amount: 500 }, { amount: 300 }], 1000)).toEqual({ toPost: [{ amount: 500 }, { amount: 300 }], adjustments: [] });
  });
  it('caps the payment that exceeds the remaining due and drops the ones that no longer fit', () => {
    const r = capPaymentsToDue([{ amount: 700 }, { amount: 700 }, { amount: 100 }], 1000);
    expect(r.toPost).toEqual([{ amount: 700 }, { amount: 300 }]);
    expect(r.adjustments).toEqual([
      { index: 1, requested: 700, applied: 300 },
      { index: 2, requested: 100, applied: 0 },
    ]);
  });
  it('unknown due: posts as-is (same as before)', () => {
    expect(capPaymentsToDue([{ amount: 900 }], null)).toEqual({ toPost: [{ amount: 900 }], adjustments: [] });
  });
});

describe('omnivore create_payment handler', () => {
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

  it('posts the payment (amount, not full) and clears the injection status when the ticket ends at 0', async () => {
    h.get.mockResolvedValueOnce(totals(2000, 0, 0)).mockResolvedValueOnce(totals(0, 2300, 1));
    h.post.mockResolvedValue({ data: { id: 'PAY-1' } });

    const out = await run();

    expect(out).toMatchObject({ applied: 1, payment_ids: ['PAY-1'], due_after: 0 });
    const body = h.post.mock.calls[0][1];
    expect(body).toEqual(payments[0]);
    expect(body).not.toHaveProperty('full');
    expect(h.post.mock.calls[0][2].headers['Idempotency-Id']).toBe('pos_inject:omnivore:25:123:create_payment:0');
    expect(statusWrites(h.state as never)).toEqual([null]); // R7: cleared
  });

  it('balance already 0 (a retry after a lost answer): posts nothing, never charges twice', async () => {
    h.get.mockResolvedValue(totals(0, 2300, 1));
    const out = await run({ attempt: 0 });
    expect(out).toMatchObject({ skipped: 'already_paid' });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('caps the amount to the ticket due and leaves a system note (I3)', async () => {
    h.get.mockResolvedValueOnce(totals(1800, 0, 0)).mockResolvedValueOnce(totals(0, 2100, 1));
    h.post.mockResolvedValue({ data: { id: 'PAY-1' } });

    const out = await run();

    expect(h.post.mock.calls[0][1]).toMatchObject({ amount: 1800, tip: 300 });
    expect(out).toMatchObject({ applied: 1, adjustments: [{ index: 0, requested: 2000, applied: 1800 }] });
    expect(notes()).toHaveLength(1);
    expect(String(notes()[0]!.patch!['content'])).toMatch(/\$20\.00.*\$18\.00/);
    expect(notes()[0]!.patch).toMatchObject({ site_id: 25, order_id: 123, is_system: true });
  });

  it('ticket keeps a balance after paying (MCM charged less): job completes, order marked needs_action TICKET_DUE_REMAINING', async () => {
    h.get.mockResolvedValueOnce(totals(2500, 0, 0)).mockResolvedValueOnce(totals(500, 2300, 1));
    h.post.mockResolvedValue({ data: { id: 'PAY-1' } });

    const out = await run();

    expect(out).toMatchObject({ applied: 1, due_after: 500 });
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ state: 'needs_action', code: 'TICKET_DUE_REMAINING', can_retry: false, ticket_id: 'TICKET-1' });
    // El staff ve cuánto falta y por qué: total en el POS = pagado + saldo (centavos).
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ amounts: { due: 500, paid: 2300, total: 2800 } });
  });

  it('payments already on the ticket but a balance remains: does not post again, asks the staff to close it', async () => {
    h.get.mockResolvedValue(totals(400, 1600, 1));
    const out = await run({ attempt: 1 });
    expect(out).toMatchObject({ skipped: 'payments_already_present' });
    expect(h.post).not.toHaveBeenCalled();
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ state: 'needs_action', code: 'TICKET_DUE_REMAINING', amounts: { due: 400, paid: 1600, total: 2000 } });
  });

  it('terminal failure with the ticket already in the kitchen: needs_action TICKET_WITHOUT_PAYMENT, retry offered, original code kept (I4)', async () => {
    h.get.mockResolvedValue(totals(2000, 0, 0));
    h.post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { errors: [{ error: 'pos_failure', description: 'tender rejected' }] } },
    });

    const err = await run({ attempt: 4, max: 5 }).catch((e) => e);

    expect(err).toBeInstanceOf(HandlerError);
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({
      state: 'needs_action',
      step: 'create_payment',
      code: 'TICKET_WITHOUT_PAYMENT',
      cause_code: 'OMNIVORE_POS_FAILURE',
      can_retry: true,
      attempt: 5,
      max_attempts: 5,
      ticket_id: 'TICKET-1',
    });
  });

  it('transient failure with attempts left: status `retrying` on the payment step', async () => {
    h.get.mockResolvedValue(totals(2000, 0, 0));
    h.post.mockRejectedValue({ isAxiosError: true, response: { status: 503, data: { errors: [{ error: 'agent_offline', description: 'x' }] } } });
    const err = await run({ attempt: 0 }).catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ state: 'retrying', step: 'create_payment', code: 'OMNIVORE_AGENT_OFFLINE', attempt: 1 });
  });

  it('no payments (e.g. a channel without payment): completes and clears the status', async () => {
    const out = await run({ payload: { payments: [] } });
    expect(out).toMatchObject({ skipped: 'no_payments' });
    expect(h.get).not.toHaveBeenCalled();
    expect(statusWrites(h.state as never)).toEqual([null]);
  });

  it('order cancelled after the ticket was created: no payment, needs_action ORDER_CANCELLED_WITH_TICKET', async () => {
    h.state.order = { status: 'cancelled', pos_injection_error: null };
    const out = await run();
    expect(out).toMatchObject({ skipped: 'order_cancelled_with_ticket' });
    expect(h.post).not.toHaveBeenCalled();
    expect(statusWrites(h.state as never).at(-1)).toMatchObject({ state: 'needs_action', code: 'ORDER_CANCELLED_WITH_TICKET' });
  });

  it('resolved by hand: nothing is posted', async () => {
    h.state.order = { status: 'in-kitchen', pos_injection_error: { state: 'resolved' } };
    const out = await run();
    expect(out).toMatchObject({ skipped: 'resolved_manually' });
    expect(h.post).not.toHaveBeenCalled();
  });
});
