import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * GUARD anti-doble-cobro del sync Clover→MCM (clover/sync/upsert-orders.ts).
 * Paridad con omnivore-payment-guard.test.ts. Si la inyección del pago a Clover
 * falla, Clover reporta la orden abierta (paymentState != PAID) y el sync la
 * reabría. Con guard, si existe un `payments` status='completed', se preservan
 * status/payment_status/paid de la fila MCM.
 */

const h = vi.hoisted(() => ({
  existingOrder: null as any,
  hasCompletedPayment: null as any,
  updates: [] as any[],
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => {
  // Soporta el lookup de F12: .or(...).order(...).limit(1).maybeSingle()
  const ordersSelectChain = (val: any) => {
    const c: any = { eq: () => c, range: () => c, order: () => c, or: () => c, order: () => c, limit: () => c, maybeSingle: async () => val, single: async () => val };
    return c;
  };
  const paymentsSelectChain = (val: any) => {
    const c: any = { eq: () => c, range: () => c, order: () => c, contains: () => c, limit: () => c, maybeSingle: async () => val, single: async () => val };
    return c;
  };
  const writeChain = () => {
    const c: any = { eq: () => c, range: () => c, order: () => c, then: (res: any) => res({ error: null }) };
    return c;
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => {
          if (table === 'payments') return paymentsSelectChain({ data: h.hasCompletedPayment, error: null });
          if (table === 'orders') return ordersSelectChain({ data: h.existingOrder, error: null });
          return ordersSelectChain({ data: null, error: null });
        },
        update: (patch: any) => {
          h.updates.push({ table, patch });
          return writeChain();
        },
        upsert: () => Promise.resolve({ error: null }),
      }),
    },
  };
});

import { upsertOrdersFromClover } from '../../src/handlers/clover/sync/upsert-orders';

// Orden Clover ABIERTA (la inyección del pago falló → paymentState OPEN, sin payments).
function openCloverOrder(overrides: Record<string, any> = {}) {
  return {
    id: 'CLV-OPEN-1',
    paymentState: 'OPEN',
    total: 2900,
    payments: { elements: [] },
    taxRates: { elements: [] },
    discounts: { elements: [] },
    lineItems: { elements: [] },
    employee: { id: 'E1', name: 'Bob' },
    orderType: { id: 'OT1', label: 'Dine In' },
    note: '',
    clientCreatedTime: 1_700_000_000_000,
    modifiedTime: 1_700_000_000_000,
    ...overrides,
  };
}

function paidMcmOrder(overrides: Record<string, any> = {}) {
  return {
    id: 55501,
    site_id: 25512412,
    channel: 'pos',
    clover_pos_id: 'CLV-OPEN-1',
    status: 'check-closed',
    payment_status: 'fulfilled',
    paid: '34.40',
    total: '29.00',
    ...overrides,
  };
}

beforeEach(() => {
  h.existingOrder = paidMcmOrder();
  h.hasCompletedPayment = null;
  h.updates = [];
});

describe('clover sync guard — orden con pago aplicado', () => {
  it('preserva status/payment_status/paid cuando existe un pago completed (no reabre)', async () => {
    h.hasCompletedPayment = { id: 901 };

    const res = await upsertOrdersFromClover(25512412, [openCloverOrder()]);

    expect(h.updates).toHaveLength(1);
    const patch = h.updates[0].patch;
    expect(patch.status).toBe('check-closed');
    expect(patch.payment_status).toBe('fulfilled');
    expect(patch.paid).toBe('34.40');
    expect(res.updated).toBe(1);
  });

  it('SIN pago completed deja que el sync refleje el estado de Clover (abierta)', async () => {
    h.hasCompletedPayment = null;

    const res = await upsertOrdersFromClover(25512412, [openCloverOrder()]);

    expect(h.updates).toHaveLength(1);
    const patch = h.updates[0].patch;
    expect(patch.status).toBe('new-order');
    expect(patch.payment_status).toBe('not_fulfilled');
    expect(patch.paid).toBe(0);
    expect(res.updated).toBe(1);
  });
});
