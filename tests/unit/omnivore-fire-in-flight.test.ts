import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Fire EN VUELO (2026-09-18): `send-to-kitchen` marca `additional_properties.omnivore_fire.in_flight_until`
 * ANTES de POSTear al POS. Mientras esté vigente, el merge managed del pull debe SALTAR la orden
 * (ningún UPDATE): merge-ar ahí conservaba la línea "sin enviar" y añadía la del POS → orden doblada.
 */

const h = vi.hoisted(() => ({ existingOrder: null as any, updates: [] as any[], upserts: [] as any[] }));

vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

vi.mock('../../src/lib/supabase', () => {
  const chain = (val: any) => { const c: any = { eq: () => c, limit: () => c, contains: () => c, is: () => c, order: () => c, maybeSingle: async () => val, single: async () => val, then: (res: any) => res(val) }; return c; };
  const writeChain = () => { const c: any = { eq: () => c, is: () => c, select: () => ({ then: (res: any) => res({ data: [{ id: 1 }], error: null }) }), then: (res: any) => res({ error: null }) }; return c; };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => {
          if (table === 'payments') return chain({ data: null, error: null });
          if (table === 'orders') return chain({ data: h.existingOrder, error: null });
          if (table === 'products') return chain({ data: [{ id: 10171, name: 'Medalla', additional_properties: { omnivoreId: '305114' } }], error: null });
          if (table === 'floor_elements') return chain({ data: [], error: null });
          return chain({ data: null, error: null });
        },
        update: (patch: any) => { h.updates.push({ table, patch }); return writeChain(); },
        upsert: (row: any) => { h.upserts.push({ table, row }); return Promise.resolve({ error: null }); },
      }),
    },
  };
});

import { isFireInFlight } from '../../src/handlers/omnivore/sync/fire-in-flight';
import { upsertOmnivoreOrders } from '../../src/handlers/omnivore/sync/upsert-orders';

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('isFireInFlight (pura)', () => {
  it('vigente → true; expirado / null / ausente / no-ISO → false', () => {
    expect(isFireInFlight({ omnivore_fire: { in_flight_until: iso(60_000) } })).toBe(true);
    expect(isFireInFlight({ omnivore_fire: { in_flight_until: iso(-1) } })).toBe(false);
    expect(isFireInFlight({ omnivore_fire: { in_flight_until: null } })).toBe(false);
    expect(isFireInFlight({})).toBe(false);
    expect(isFireInFlight(null)).toBe(false);
    expect(isFireInFlight({ omnivore_fire: { in_flight_until: 'ayer' } })).toBe(false);
  });
});

const SITE = 25612612;
const config = { omnivoreId: 'cx9oRBRi', apiKey: 'x', omnivoreTableServiceEnabled: true };
// Ticket del POS con el ítem YA aterrizado (el fire hizo el POST) y la orden MCM aún sin estampar.
const ticket = () => ({
  id: 'T1', name: 'MCM 500', open: true, opened_at: 1758200000, totals: { due: 1227, paid: 0, total: 1227, sub_total: 1100, tax: 127 },
  _embedded: { items: [{ id: '93333096', sent: true, sent_at: 1758200010, name: 'Medalla', price: 1100, quantity: 1, _embedded: { menu_item: { id: '305114' } } }], employee: { id: '975' }, order_type: { id: '1' }, revenue_center: { id: '20' } },
});
const mcmOrder = (ap: any) => ({
  id: 500, site_id: SITE, status: 'new-order', payment_status: 'not_fulfilled', paid: 0, subtotal: 11, total: 12.27, total_tax: 1.27, date_updated: '2026-09-18T00:00:00.000Z',
  channel: 'pos', experience: 'qe', omnivore_pos_id: 'T1', line_items: [{ id: 'g1', product_id: 10171, quantity: 1, notes: '', status: null, total: '11', total_tax: '1.27', additional_properties: {} }],
  additional_properties: { omnivore_managed: true, omnivore_synced_at: '2026-09-17T00:00:00.000Z', ...ap },
});

describe('upsertOmnivoreOrders · guard de fire en vuelo (rama managed)', () => {
  beforeEach(() => { h.updates.length = 0; h.upserts.length = 0; });

  it('con in_flight_until vigente → NINGÚN update (la orden se salta)', async () => {
    h.existingOrder = mcmOrder({ omnivore_fire: { in_flight_until: iso(60_000), fire_id: 'F' } });
    const r = await upsertOmnivoreOrders(SITE, [ticket()], config as any, iso(-5_000));
    expect(h.updates.filter((u) => u.table === 'orders')).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('con in_flight_until expirado y línea con fire_pending_at → se merge-a y la línea ADOPTA el ítem (sin duplicar)', async () => {
    const o = mcmOrder({ omnivore_fire: { in_flight_until: iso(-1_000), fire_id: 'F' } });
    o.line_items[0].additional_properties = { omnivore: { fire_pending_at: iso(-30_000), fire_id: 'F' } };
    h.existingOrder = o;
    await upsertOmnivoreOrders(SITE, [ticket()], config as any, iso(-5_000));
    const upd = h.updates.filter((u) => u.table === 'orders');
    expect(upd).toHaveLength(1);
    const lines = upd[0].patch.line_items;
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe('g1'); expect(lines[0].status).toBe('sent');
    expect(lines[0].additional_properties.omnivore.item_id).toBe('93333096');
  });

  it('sin marcador (estado previo al fix) → el merge sigue produciendo el duplicado (documenta el bug que cierra la fase 0)', async () => {
    h.existingOrder = mcmOrder({});
    await upsertOmnivoreOrders(SITE, [ticket()], config as any, iso(-5_000));
    const upd = h.updates.filter((u) => u.table === 'orders');
    expect(upd).toHaveLength(1);
    expect(upd[0].patch.line_items).toHaveLength(2);
  });
});
