import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * GUARD anti-doble-cobro del sync Omnivore→MCM (upsert-orders.ts).
 *
 * Escenario del bug: se paga la orden en MCM (queda check-closed/fulfilled/paid),
 * la inyección del pago a Omnivore falla, y Omnivore reporta la orden abierta
 * (due>0, paid=0). Sin guard, el sync pisa la orden a new-order/not_fulfilled/0
 * → re-pagable. Con guard, si existe un `payments` status='completed' para la
 * orden, se PRESERVAN sus campos de pago (status/payment_status/paid).
 */

const h = vi.hoisted(() => ({
  existingOrder: null as any,
  hasCompletedPayment: null as any, // fila de payments devuelta por el guard (o null)
  updates: [] as any[],
  upserts: [] as any[],
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => {
  const ordersSelectChain = (val: any) => {
    const c: any = { eq: () => c, limit: () => c, maybeSingle: async () => val, single: async () => val };
    return c;
  };
  // El guard usa .select('id').eq().contains().eq().limit().maybeSingle()
  const paymentsSelectChain = (val: any) => {
    const c: any = { eq: () => c, contains: () => c, limit: () => c, maybeSingle: async () => val, single: async () => val };
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
          if (table === 'payments') return paymentsSelectChain({ data: h.hasCompletedPayment, error: null });
          if (table === 'orders') return ordersSelectChain({ data: h.existingOrder, error: null });
          return ordersSelectChain({ data: null, error: null });
        },
        update: (patch: any) => {
          h.updates.push({ table, patch });
          return writeChain();
        },
        upsert: (row: any) => {
          h.upserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      }),
    },
  };
});

import { upsertOmnivoreOrders } from '../../src/handlers/omnivore/sync/upsert-orders';

const config = { standardProductsCategories: [] as string[] };

// Ticket Omnivore ABIERTO (la inyección del pago falló → due>0, paid=0).
function openOmnivoreTicket(overrides: Record<string, any> = {}) {
  return {
    id: '20260609-10001',
    name: 'Mesa 5',
    opened_at: 1_700_000_000,
    closed_at: null,
    totals: { due: 2900, paid: 0, items: 2900, discounts: 0, service_charges: 0, tax: 0, total: 2900 },
    _embedded: { employee: {}, order_type: {}, revenue_center: {}, table: {}, items: [] },
    ...overrides,
  };
}

// Orden MCM YA pagada (cerrada por un pago en MCM).
function paidMcmOrder(overrides: Record<string, any> = {}) {
  return {
    id: 10344,
    site_id: 48372619,
    channel: 'pos',
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
  h.upserts = [];
});

describe('omnivore sync guard — orden con pago aplicado', () => {
  it('preserva status/payment_status/paid cuando existe un pago completed (no reabre)', async () => {
    h.hasCompletedPayment = { id: 777 }; // el guard encuentra un pago completed

    const res = await upsertOmnivoreOrders(48372619, [openOmnivoreTicket()], config);

    // Hubo update (otros campos como total difieren), pero los campos de pago se preservaron.
    expect(h.updates).toHaveLength(1);
    const patch = h.updates[0].patch;
    expect(patch.status).toBe('check-closed');
    expect(patch.payment_status).toBe('fulfilled');
    expect(patch.paid).toBe('34.40');
    expect(res.updated).toBe(1);
  });

  it('SIN pago completed deja que el sync refleje el estado de Omnivore (abierta)', async () => {
    h.hasCompletedPayment = null; // no hay pago → guard no aplica

    const res = await upsertOmnivoreOrders(48372619, [openOmnivoreTicket()], config);

    expect(h.updates).toHaveLength(1);
    const patch = h.updates[0].patch;
    expect(patch.status).toBe('new-order');
    expect(patch.payment_status).toBe('not_fulfilled');
    expect(patch.paid).toBe(0);
    expect(res.updated).toBe(1);
  });

  it('fail-safe: si el lookup de payments falla, preserva los campos de pago', async () => {
    // Forzamos error en el lookup de payments.
    h.hasCompletedPayment = undefined;
    const { supabase } = (await import('../../src/lib/supabase')) as any;
    const origFrom = supabase.from;
    supabase.from = (table: string) => {
      if (table === 'payments') {
        const c: any = { eq: () => c, contains: () => c, limit: () => c, maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) };
        return { select: () => c };
      }
      return origFrom(table);
    };

    const res = await upsertOmnivoreOrders(48372619, [openOmnivoreTicket()], config);
    supabase.from = origFrom;

    expect(h.updates).toHaveLength(1);
    const patch = h.updates[0].patch;
    expect(patch.status).toBe('check-closed'); // preservado por fail-safe
    expect(patch.payment_status).toBe('fulfilled');
    expect(res.updated).toBe(1);
  });
});
