import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Modo gestionado en el pull de Clover.
 *
 * El test que manda es el primero: un site SIN `cloverTableServiceEnabled` y sin
 * `clover_managed` tiene que comportarse EXACTAMENTE como antes (camino destructivo).
 * Es la garantía de que encender esto no cambia nada para nadie que no lo pida.
 */

const h = vi.hoisted(() => ({
  existingOrder: null as any,
  updates: [] as any[],
  upserts: [] as any[],
  casRows: [{ id: 1 }] as any,   // por defecto el CAS gana
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => {
  const chain = (terminal: any, arrayVal: any = null) => {
    const c: any = {
      eq: () => c, range: () => c, order: () => c, or: () => c, contains: () => c, is: () => c, order: () => c, limit: () => c,
      maybeSingle: async () => terminal,
      single: async () => terminal,
      then: (res: any) => res(arrayVal ?? terminal),
    };
    return c;
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => {
          if (table === 'products') return chain({ data: [] }, { data: [] });
          if (table === 'payments') return chain({ data: null, error: null });
          if (table === 'orders') return chain({ data: h.existingOrder, error: null });
          return chain({ data: null, error: null });
        },
        update: (patch: any) => {
          h.updates.push({ table, patch });
          const w: any = {
            eq: () => w,
            select: () => ({ then: (res: any) => res({ data: h.casRows, error: null }) }),
            then: (res: any) => res({ error: null }),
          };
          return w;
        },
        upsert: (row: any) => {
          h.upserts.push({ table, row });
          return { eq: () => ({ then: (r: any) => r({ error: null }) }), then: (r: any) => r({ error: null }) };
        },
      }),
    },
  };
});

import { upsertOrdersFromClover } from '../../src/handlers/clover/sync/upsert-orders';

const SITE = 99990004;

const cloverOrder = (els: any[]) => ({
  id: 'CLV1', total: 500, paymentState: 'OPEN',
  clientCreatedTime: 1700000000000, modifiedTime: 1700000001000,
  lineItems: { elements: els },
});
const cl = (id: string, name: string, price: number, itemId = 'ITEM_A') =>
  ({ id, name, price, item: { id: itemId } });

/** `name` es lo que correlaciona: `product_id` no hace el viaje de ida y vuelta. */
const mcmLine = (id: string, name: string, price: string, extra: any = {}) =>
  ({ id, name, product_id: '', price, quantity: 1, notes: '', status: 'new',
     // Las líneas reales de MCM llevan `total` y `total_tax`; el fixture no los tenía y por eso
     // el preview salía a cero. Es de lo que se alimenta la suma de totales.
     total: (Number(price) * 1).toFixed(2), total_tax: '0', ...extra });

const existing = (over: any = {}) => ({
  id: 10, site_id: SITE, channel: 'pos', status: 'new-order', payment_status: 'not_fulfilled',
  paid: 0, total: 1, date_updated: '2026-08-26T22:00:00.000Z',
  line_items: [], additional_properties: {}, ...over,
});

beforeEach(() => { h.updates = []; h.upserts = []; h.existingOrder = null; h.casRows = [{ id: 1 }]; });
const patch = () => h.updates.find((u) => u.table === 'orders')?.patch;
const inserted = () => h.upserts.find((u) => u.table === 'orders')?.row;

describe('pull de Clover · modo gestionado', () => {
  it('SIN la bandera: camino de siempre — sobrescribe line_items y NO estampa clover_managed', async () => {
    h.existingOrder = existing({ line_items: [mcmLine('u1', 'Café', '2.50')] });
    await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Café', 250)])]);   // sin opts

    const p = patch();
    expect(p).toBeTruthy();
    expect(p.additional_properties?.clover_managed).toBeUndefined();
    // el camino viejo escribe la orden entera mapeada: 1 linea con id posicional
    expect(p.line_items[0].id).toBe('lineitem-0');
  });

  it('CON la bandera: hace merge, conserva el uuid de MCM y estampa clover_managed', async () => {
    h.existingOrder = existing({ line_items: [mcmLine('u1', 'Café', '2.50')] });
    await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Café', 250, '500')])],
      { tableServiceEnabled: true, fetchStartIso: '2026-08-26T23:00:00.000Z' });

    const p = patch();
    expect(p.additional_properties.clover_managed).toBe(true);
    expect(p.additional_properties.clover_synced_at).toBeTruthy();
    expect(p.line_items).toHaveLength(1);
    expect(p.line_items[0].id).toBe('u1');                       // conserva su identidad
    expect(p.line_items[0].additional_properties.clover.line_item_ids).toEqual(['C1']);
  });

  it('una línea local sin empujar NO se pierde, y su importe SE SUMA al total del POS', async () => {
    h.existingOrder = existing({
      line_items: [mcmLine('u1', 'Café', '2.50'), mcmLine('u2', 'Tostada', '4.00')],
      total: 6.5,
    });
    // En Clover sólo está el café (500c). La tostada aún no se ha empujado.
    await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Café', 250, '500')])],
      { tableServiceEnabled: true });

    const p = patch();
    expect(p.line_items).toHaveLength(2);
    const u2 = p.line_items.find((l: any) => l.id === 'u2');
    expect(u2.status).toBe('new');            // intacta

    // Antes se descartaba el total del POS y quedaba el de MCM — de ahí el sub-cobro cuando el
    // terminal había añadido algo. Ahora: total del POS (5.00) + la tostada pendiente (4.00).
    expect(p.total).toBe(9);
    expect(p.subtotal).toBe(9);
  });

  // La regresión que hay que evitar: la orden nace VACÍA en Clover al abrir la mesa
  // (`openCloverTicketForManagedOrder`). Si se tomara su total, el mesero vería «Cobrar $0.00».
  it('ticket de Clover VACÍO: se conservan los totales de MCM, no se pisan con cero', async () => {
    h.existingOrder = existing({
      line_items: [mcmLine('u1', 'Café', '2.50'), mcmLine('u2', 'Tostada', '4.00')],
      total: 6.5,
    });
    await upsertOrdersFromClover(SITE, [cloverOrder([])], { tableServiceEnabled: true });

    // La invariante es que el total NUNCA se pise con el del ticket vacío. Que además no se
    // escriba nada (el anti-churn ve que no cambió nada) es aún mejor, así que se acepta cualquiera
    // de las dos formas: lo que no puede pasar es que `total` acabe valiendo 0.
    expect(patch()?.total).toBeUndefined();
    expect(patch()?.subtotal).toBeUndefined();
  });

  // MEDIDO (H-N15): en modo gestionado las líneas se añaden una a una por API y Clover NO computa
  // `order.total` — devuelve undefined, y `undefined/100` es NaN, que aterriza como `total: null`.
  // 3 de las 6 órdenes gestionadas del banco están así, cobradas y sin total.
  it('Clover no devuelve total (modo gestionado): se calcula desde sus líneas, no queda NaN', async () => {
    h.existingOrder = existing({ line_items: [mcmLine('u1', 'Café', '2.50')] });
    const sinTotal: any = cloverOrder([cl('C1', 'Café', 250, '500')]);
    delete sinTotal.total;                       // como lo devuelve Clover de verdad

    await upsertOrdersFromClover(SITE, [sinTotal], { tableServiceEnabled: true });

    const p = patch();
    expect(p.total).toBe(2.5);                   // 250c de la línea
    expect(Number.isNaN(p.total)).toBe(false);
    expect(p.total).not.toBeNull();
  });

  it('sin líneas pendientes, el preview es cero y el total es el del POS', async () => {
    h.existingOrder = existing({ line_items: [mcmLine('u1', 'Café', '2.50')] });
    await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Café', 250, '500')])],
      { tableServiceEnabled: true });
    expect(patch().total).toBe(5);            // 500 centavos
  });

  it('guard de frescura: si un push escribió después del snapshot, no se pisa', async () => {
    h.existingOrder = existing({
      line_items: [mcmLine('u1', 'Café', '2.50')],
      additional_properties: { clover_managed: true, clover_synced_at: '2026-08-26T23:30:00.000Z' },
    });
    const r = await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Café', 250, '500')])],
      { tableServiceEnabled: true, fetchStartIso: '2026-08-26T23:00:00.000Z' });

    expect(h.updates).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('CAS perdido (el mesero escribió): no cuenta como actualizada, se reintegra luego', async () => {
    h.casRows = [];   // 0 filas → alguien cambió date_updated
    h.existingOrder = existing({ line_items: [mcmLine('u1', 'Café', '2.50')] });
    const r = await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Café', 250, '500')])],
      { tableServiceEnabled: true });
    expect(r.updated).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('anti-churn: si nada cambió de verdad, no escribe (no despierta el realtime del mesero)', async () => {
    const yaCasada = {
      ...mcmLine('u1', 'Café', '2.50', { status: 'sent' }),
      additional_properties: { clover: { line_item_ids: ['C1'], line_item_id: 'C1' } },
    };
    h.existingOrder = existing({
      line_items: [yaCasada], total: 5, paid: 0,
      additional_properties: { clover_managed: true },
    });
    const r = await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Café', 250, '500')])],
      { tableServiceEnabled: true });

    expect(h.updates).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('una orden con clover_managed ya puesto entra al merge aunque la bandera esté apagada', async () => {
    h.existingOrder = existing({
      line_items: [mcmLine('u1', 'Café', '2.50')],
      additional_properties: { clover_managed: true },
    });
    await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Café', 250, '500')])]);  // sin opts
    expect(patch().line_items[0].id).toBe('u1');
  });

  // ── Orden NACIDA en Clover (camino de INSERT) ──────────────────────────────
  it('NACIDA-EN-CLOVER · con la bandera queda sellada como gestionada al insertarse', async () => {
    h.existingOrder = null;                       // no existe en MCM todavía
    await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Cerveza', 500)])],
      { tableServiceEnabled: true, fetchStartIso: '2026-08-26T23:00:00.000Z' });

    const row = inserted();
    expect(row).toBeTruthy();
    // Sin este sello, `/pos-order` no la reconoce (las edge exigen `clover_managed === true`)
    // y firear un ítem nuevo NO llegaría al terminal en el PRIMER servicio de la mesa.
    expect(row.additional_properties.clover_managed).toBe(true);
    expect(row.additional_properties.clover_synced_at).toBeTruthy();
  });

  it('NACIDA-EN-CLOVER · SIN la bandera no se sella nada (nada cambia para quien no lo pide)', async () => {
    h.existingOrder = null;
    await upsertOrdersFromClover(SITE, [cloverOrder([cl('C1', 'Cerveza', 500)])]);   // sin opts

    const row = inserted();
    expect(row).toBeTruthy();
    expect(row.additional_properties?.clover_managed).toBeUndefined();
  });

  // ── Una orden marcada `Deleted` en Clover no resucita ──────────────────────
  it('una orden `Deleted` en Clover NO se importa como ticket vivo', async () => {
    h.existingOrder = null;
    const borrada = { ...cloverOrder([cl('C1', 'Fantasma', 100)]), state: 'Deleted' };
    const r = await upsertOrdersFromClover(SITE, [borrada], { tableServiceEnabled: true });

    // Medido contra el merchant: `state:'Deleted'` devuelve 200 y deja la orden viva en el
    // pull, con sus líneas. Sin filtro entraba como `new-order` en la pantalla de mesas.
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
    expect(inserted()).toBeUndefined();
  });

  it('el filtro de `Deleted` no distingue mayúsculas y deja pasar lo demás', async () => {
    h.existingOrder = null;
    const r1 = await upsertOrdersFromClover(SITE, [{ ...cloverOrder([cl('C1', 'X', 100)]), state: 'deleted' }]);
    expect(r1.skipped).toBe(1);
    h.upserts = [];
    const r2 = await upsertOrdersFromClover(SITE, [{ ...cloverOrder([cl('C1', 'X', 100)]), state: 'open' }]);
    expect(r2.inserted).toBe(1);
  });
});
