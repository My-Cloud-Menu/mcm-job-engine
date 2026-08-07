import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  mapRow: null as any,
  injected: null as any,
  order: null as any,
  completedPayments: [] as any[], // Bug 2: filas devueltas por la query de acumulado
  newPaymentId: 999,
  inserts: [] as any[],
  updates: [] as any[],
  upserts: [] as any[],
}));

vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
// Omnivore active by default (so the forward path can be exercised); tests that
// don't set `order.pos_id` never reach the enqueue.
vi.mock('../../src/lib/credentials', () => ({
  getSiteIntegrationConfig: vi.fn(async () => ({
    config: { defaultTenderId: 'DEF', tenderIdVisa: 'VISA' },
    integrationId: 'i',
  })),
}));
vi.mock('../../src/enqueue/helpers', () => ({
  enqueuePaymentInjection: vi.fn(async () => 'omni-job-1'),
}));
vi.mock('../../src/lib/supabase', () => {
  // `val` = resultado de maybeSingle()/single(); `arrayVal` = resultado cuando la
  // query se `await`-ea directo sin terminal (Bug 2: select de pagos completed).
  const selectChain = (val: any, arrayVal: any = null) => {
    const c: any = {
      eq: () => c,
      or: () => c,
      contains: () => c,
      is: () => c,
      limit: () => c,
      maybeSingle: async () => val,
      single: async () => val,
      then: (res: any) => res({ data: arrayVal }),
    };
    return c;
  };
  const writeChain = () => {
    const c: any = { eq: () => c, then: (res: any) => res({ error: null }) };
    return c;
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => {
          if (table === 'clover_payment_map') return selectChain({ data: h.mapRow });
          if (table === 'payments') return selectChain({ data: h.injected }, h.completedPayments);
          if (table === 'orders') return selectChain({ data: h.order });
          return selectChain({ data: null });
        },
        insert: (row: any) => {
          h.inserts.push({ table, row });
          return { select: () => ({ single: async () => ({ data: { id: h.newPaymentId }, error: null }) }) };
        },
        update: (patch: any) => {
          h.updates.push({ table, patch });
          return writeChain();
        },
        upsert: (row: any, opts: any) => {
          h.upserts.push({ table, row, opts });
          // payments: `.upsert(...).select('id').single()`; clover_payment_map: `await upsert(...)`.
          const result = { data: table === 'payments' ? { id: h.newPaymentId } : null, error: null };
          return {
            select: () => ({ single: async () => result }),
            then: (res: any) => res({ error: null }),
          };
        },
      }),
    },
  };
});

import { summarizeCloverPayment } from '../../src/handlers/clover/sync/payment-mapper';
import { upsertCloverPayments } from '../../src/handlers/clover/sync/upsert-payments';
import { enqueuePaymentInjection } from '../../src/enqueue/helpers';

function cloverPayment(over: Record<string, any> = {}) {
  return {
    id: 'CP1',
    order: { id: 'CORD1' },
    amount: 2000,
    tipAmount: 0,
    result: 'SUCCESS',
    modifiedTime: 1_700_000_500,
    cardTransaction: { cardType: 'VISA' },
    externalPaymentId: null,
    refunds: { elements: [] },
    ...over,
  };
}

beforeEach(() => {
  h.mapRow = null;
  h.injected = null;
  h.order = null;
  h.completedPayments = [];
  h.inserts.length = 0;
  h.updates.length = 0;
  h.upserts.length = 0;
  (enqueuePaymentInjection as any).mockClear();
});

describe('summarizeCloverPayment', () => {
  it('computes voided + totalRefunded', () => {
    const s = summarizeCloverPayment(cloverPayment({ result: 'VOIDED', refunds: { elements: [{ amount: 500 }, { amount: 200 }] } }));
    expect(s).toMatchObject({ cloverPaymentId: 'CP1', cloverOrderId: 'CORD1', voided: true, totalRefunded: 700, amount: 2000, cardType: 'VISA' });
  });
});

describe('upsertCloverPayments', () => {
  it('creates a new MCM payment + map for a fresh Clover payment (fully paid)', async () => {
    h.order = { id: 123, total: '20.00', channel: 'pos' };
    h.completedPayments = [{ total: '20.00' }]; // el pago recién insertado cubre el total
    const r = await upsertCloverPayments(25, [cloverPayment()]);
    expect(r.created).toBe(1);
    // Fix 1: el pago ahora se UPSERTEA (onConflict site_id,pos_id) en vez de insert plano.
    const ins = h.upserts.find((i) => i.table === 'payments');
    expect(ins.row).toMatchObject({ pos_id: 'CP1', reference: 'CP1', total: '20.00', orders_ids: [123] });
    expect(ins.opts).toMatchObject({ onConflict: 'site_id,pos_id' });
    // Cubre el total → fulfilled + check-closed
    expect(h.updates.find((u) => u.table === 'orders')?.patch).toMatchObject({
      payment_status: 'fulfilled',
      status: 'check-closed',
      paid: '20.00',
      clover_payment_id: 'CP1',
    });
    expect(h.upserts.find((u) => u.table === 'clover_payment_map')?.row).toMatchObject({ clover_payment_id: 'CP1', mcm_payment_id: 999 });
    expect(r.maxModifiedTime).toBe(1_700_000_500);
  });

  /**
   * El monto que llega al POS debe CUBRIR el cheque; la propina viaja aparte.
   *
   * Cheque de $23.00 cobrado en Clover con $3.00 de propina → el cliente paga $26.00.
   * Clover reporta `amount: 2300` (el cheque, SIN propina) y `tipAmount: 300`.
   * Al POS hay que enviarle `amount: 2300` + `tip: 300`.
   *
   * Antes esta prueba esperaba `amount: 2000` — o sea el cheque MENOS la propina, corto
   * justo por su valor: `payments.total` se guardaba sin propina y `buildOmnivorePaymentBody`
   * se la volvía a restar. Fijaba el bug como contrato. Ocurrió en producción el 2026-08-07
   * (orden 10334: se envió 3189 en vez de 5189 y el cheque quedó debiendo $20.00).
   */
  it('reenvía a Omnivore el monto que CUBRE el cheque, con la propina aparte', async () => {
    h.order = { id: 123, total: '23.00', channel: 'pos', pos_id: 'OMNI-TICKET' };
    // `payments.total` incluye la propina; su aporte al cheque es `total − tip`.
    h.completedPayments = [{ total: '26.00', tip: '3.00' }];
    await upsertCloverPayments(25, [cloverPayment({ amount: 2300, tipAmount: 300 })]);

    expect(enqueuePaymentInjection).toHaveBeenCalledTimes(1);
    expect(enqueuePaymentInjection).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: 25,
        orderId: 123,
        ticketId: 'OMNI-TICKET',
        posProvider: 'omnivore',
        posIdField: 'additional_properties.omnivore_payment_id',
        maxAttempts: 4,
        payment: expect.objectContaining({ amount: 2300, tip: 300, type: '3rd_party' }),
      })
    );
  });

  it('guarda en payments.total lo COBRADO al cliente (cheque + propina)', async () => {
    h.order = { id: 123, total: '23.00', channel: 'pos' };
    h.completedPayments = [{ total: '26.00', tip: '3.00' }];
    await upsertCloverPayments(25, [cloverPayment({ amount: 2300, tipAmount: 300 })]);
    const ins = h.upserts.find((i: any) => i.table === 'payments');
    expect(ins.row).toMatchObject({ total: '26.00', tip: '3.00' });
    // …y la orden se da por pagada con `Σ(total − tip)` = 23.00, que es su `orders.total`.
    expect(h.updates.find((u: any) => u.table === 'orders')?.patch).toMatchObject({
      paid: '23.00', payment_status: 'fulfilled',
    });
  });

  it('does NOT forward to Omnivore when the order has no Omnivore ticket (pos_id)', async () => {
    h.order = { id: 123, total: '20.00', channel: 'pos' }; // no pos_id
    h.completedPayments = [{ total: '20.00' }];
    await upsertCloverPayments(25, [cloverPayment()]);
    expect(enqueuePaymentInjection).not.toHaveBeenCalled();
  });

  it('does NOT forward a voided Clover payment to Omnivore', async () => {
    h.order = { id: 123, total: '20.00', channel: 'pos', pos_id: 'OMNI-TICKET' };
    await upsertCloverPayments(25, [cloverPayment({ result: 'VOIDED' })]);
    expect(enqueuePaymentInjection).not.toHaveBeenCalled();
  });

  it('Bug 2 (#10349): pago parcial NO marca fulfilled/check-closed', async () => {
    // Pago de $20.00 (cloverPayment amount=2000) sobre una orden de $32.00.
    h.order = { id: 123, total: '32.00', channel: 'pos' };
    h.completedPayments = [{ total: '20.00' }];
    const r = await upsertCloverPayments(25, [cloverPayment()]);
    expect(r.created).toBe(1);
    const patch = h.updates.find((u) => u.table === 'orders')?.patch;
    expect(patch).toMatchObject({ payment_status: 'partially_fulfilled', paid: '20.00' });
    expect(patch.status).toBeUndefined(); // NO se cierra el cheque
  });

  it('anti-loop: does not duplicate a payment MCM injected (pos_id match) — maps it', async () => {
    h.injected = { id: 55 };
    const r = await upsertCloverPayments(25, [cloverPayment({ externalPaymentId: 'Invoice #: 7' })]);
    expect(r.created).toBe(0);
    expect(h.upserts.find((i) => i.table === 'payments')).toBeUndefined();
    expect(h.upserts.find((u) => u.table === 'clover_payment_map')?.row).toMatchObject({ clover_payment_id: 'CP1', mcm_payment_id: 55 });
  });

  it('reflects a later refund on an already-mapped payment', async () => {
    h.mapRow = { id: 'map-1', mcm_payment_id: 55, voided: false, total_refunded: 0 };
    const r = await upsertCloverPayments(25, [cloverPayment({ refunds: { elements: [{ amount: 500 }] } })]);
    expect(r.updated).toBe(1);
    expect(h.updates.find((u) => u.table === 'clover_payment_map')?.patch).toMatchObject({ total_refunded: 500 });
    expect(h.updates.find((u) => u.table === 'payments')?.patch).toMatchObject({ total_refunded: '5.00' });
    expect(h.inserts.length).toBe(0);
  });

  it('skips an already-mapped payment with no changes', async () => {
    h.mapRow = { id: 'map-1', mcm_payment_id: 55, voided: false, total_refunded: 0 };
    const r = await upsertCloverPayments(25, [cloverPayment()]);
    expect(r.skipped).toBe(1);
    expect(r.updated).toBe(0);
    expect(h.updates.length).toBe(0);
  });

  it('leaves a payment whose order is not synced yet (never lost)', async () => {
    h.order = null;
    const r = await upsertCloverPayments(25, [cloverPayment()]);
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(1);
    expect(h.inserts.length).toBe(0);
  });
});
