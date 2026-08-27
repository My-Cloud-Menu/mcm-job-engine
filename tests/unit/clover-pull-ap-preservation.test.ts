import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * A1 — el pull de órdenes de Clover NO debe borrar `orders.additional_properties`.
 *
 * `order-mapper.ts` emite `additional_properties: {}` a nivel de orden y
 * `upsert-orders.ts` escribía `order` entero con `.update()`, así que cada ciclo
 * borraba todo lo que viviera ahí: el manifiesto `clover_supplemental` (única
 * forma de que el pago de una orden suplementaria encuentre a su padre) y, en un
 * site con las dos integraciones, `omnivore_managed` / `omnivore_synced_at`.
 *
 * Ironía medida en la auditoría: el pull de OMNIVORE sí preserva el manifiesto de
 * Clover; era el de Clover el que destruía lo que el de Omnivore cuidaba.
 */

const h = vi.hoisted(() => ({
  existingOrder: null as any,
  updates: [] as any[],
  upserts: [] as any[],
  hasPayment: null as any,
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => {
  const chain = (terminal: any, arrayVal: any = null) => {
    const c: any = {
      eq: () => c, range: () => c, order: () => c,
      or: () => c,
      contains: () => c,
      is: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: async () => terminal,
      single: async () => terminal,
      then: (res: any) => res(arrayVal ?? terminal),
    };
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
          if (table === 'products') return chain({ data: [] }, { data: [] });
          if (table === 'payments') return chain({ data: h.hasPayment, error: null });
          if (table === 'orders') return chain({ data: h.existingOrder, error: null });
          return chain({ data: null, error: null });
        },
        update: (patch: any) => { h.updates.push({ table, patch }); return writeChain(); },
        upsert: (row: any) => { h.upserts.push({ table, row }); return writeChain(); },
      }),
    },
  };
});

import { upsertOrdersFromClover } from '../../src/handlers/clover/sync/upsert-orders';

const SITE = 99990004;

// Orden de Clover con un total distinto al de la fila MCM existente, para que
// `verifyOrderHasRelevantChanges` devuelva true y se dispare el UPDATE.
const cloverOrder = {
  id: 'CLV1',
  total: 2500,
  paymentState: 'OPEN',
  clientCreatedTime: 1700000000000,
  modifiedTime: 1700000001000,
  lineItems: { elements: [{ id: 'LI1', name: 'Café', price: 2500, item: { id: 'ITEM_A' } }] },
};

const existing = (additional_properties: any) => ({
  id: 10347,
  site_id: SITE,
  channel: 'pos',
  status: 'new-order',
  payment_status: 'not_fulfilled',
  paid: 0,
  total: 1,            // distinto → fuerza el update
  additional_properties,
});

beforeEach(() => {
  h.updates = [];
  h.upserts = [];
  h.hasPayment = null;
  h.existingOrder = null;
});

const patchOf = () => h.updates.find((u) => u.table === 'orders')?.patch;

describe('A1 · el pull de Clover preserva orders.additional_properties', () => {
  it('conserva el manifiesto clover_supplemental', async () => {
    const manifest = { primary_order_id: 'CLV0', delta_signature: 'abc', supplements: [{ id: 'S1' }] };
    h.existingOrder = existing({ clover_supplemental: manifest });

    await upsertOrdersFromClover(SITE, [cloverOrder]);

    const patch = patchOf();
    expect(patch, 'el update debe haberse disparado').toBeTruthy();
    expect(patch.additional_properties.clover_supplemental).toEqual(manifest);
  });

  it('conserva las claves de Omnivore en un site con las dos integraciones', async () => {
    h.existingOrder = existing({
      omnivore_managed: true,
      omnivore_synced_at: '2026-08-26T22:00:00.000Z',
      clover_supplemental: { delta_signature: 'x' },
    });

    await upsertOrdersFromClover(SITE, [cloverOrder]);

    const ap = patchOf().additional_properties;
    expect(ap.omnivore_managed).toBe(true);
    expect(ap.omnivore_synced_at).toBe('2026-08-26T22:00:00.000Z');
    expect(ap.clover_supplemental).toEqual({ delta_signature: 'x' });
  });

  it('no revienta si additional_properties viene null', async () => {
    h.existingOrder = existing(null);
    await upsertOrdersFromClover(SITE, [cloverOrder]);
    expect(patchOf().additional_properties).toEqual({});
  });

  it('tolera additional_properties guardado como string JSON', async () => {
    h.existingOrder = existing(JSON.stringify({ clover_supplemental: { delta_signature: 'z' } }));
    await upsertOrdersFromClover(SITE, [cloverOrder]);
    expect(patchOf().additional_properties.clover_supplemental).toEqual({ delta_signature: 'z' });
  });

  it('una orden NUEVA sigue naciendo con additional_properties vacío', async () => {
    h.existingOrder = null;   // no existe en MCM → INSERT
    await upsertOrdersFromClover(SITE, [cloverOrder]);
    expect(h.updates.length).toBe(0);
    expect(h.upserts.length).toBe(1);
    expect(h.upserts[0].row.additional_properties).toEqual({});
  });
});
