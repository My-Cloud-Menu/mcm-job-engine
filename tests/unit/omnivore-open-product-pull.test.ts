import { describe, it, expect } from 'vitest';
import { convertOmnivoreOrderToMCMOrder } from '../../src/handlers/omnivore/sync/order-mapper';
import {
  getConfiguredOpenProductIds,
  isOpenProductEnabled,
  normalizeOpenProductName,
} from '../../src/handlers/omnivore/open-product';

// Los 2 ítems `open_name: true` que usa el location de pruebas cx9oRBRi.
const OPEN_FOOD = '320005';
const OPEN_LIQUOR = '320015';

const CONFIG_OFF = { standardProductsCategories: ['1003'] };
const CONFIG_ON = {
  ...CONFIG_OFF,
  omnivoreOpenProductEnabled: true,
  omnivoreOpenProductId: OPEN_FOOD,
  omnivoreOpenProductIdByTaxClass: { standard: OPEN_LIQUOR },
};

/** Ticket con 2 líneas que MCM inyectó bajo el MISMO producto global. */
function openTicket() {
  return {
    id: '537079',
    name: 'MCM 42',
    opened_at: 1_700_000_000,
    closed_at: null,
    open: true,
    totals: { due: 2125, paid: 0, items: 2125, discounts: 0, service_charges: 0, tax: 0, total: 2125 },
    _embedded: {
      items: [
        {
          id: '900', sent: true, name: 'Mofongo Relleno', comment: '', price: 1250, quantity: 1,
          _embedded: { menu_item: { id: OPEN_FOOD, _embedded: { menu_categories: [] } } },
        },
        {
          id: '901', sent: true, name: 'Ensalada Cesar', comment: '', price: 875, quantity: 1,
          _embedded: { menu_item: { id: OPEN_FOOD, _embedded: { menu_categories: [] } } },
        },
      ],
    },
  };
}

// El producto MCM que espeja el open product del POS, más los platos reales.
const omnivoreIdToProductId = new Map<string, number>([[OPEN_FOOD, 10383]]);
const productIdByName = new Map<string, number>([
  ['mofongo relleno', 5001],
  ['ensalada cesar', 5002],
]);

describe('open product — resolución del pull', () => {
  it('bandera apagada: se resuelve por menu_item, como siempre', () => {
    const o: any = convertOmnivoreOrderToMCMOrder(
      openTicket(), CONFIG_OFF, omnivoreIdToProductId, productIdByName,
    );
    // Sin ids configurados el bloque por nombre no entra: ambas líneas caen en el open product.
    expect(o.line_items[0].product_id).toBe(10383);
    expect(o.line_items[1].product_id).toBe(10383);
  });

  it('bandera encendida: cada línea recupera SU producto real por nombre', () => {
    const o: any = convertOmnivoreOrderToMCMOrder(
      openTicket(), CONFIG_ON, omnivoreIdToProductId, productIdByName,
    );
    expect(o.line_items[0].product_id).toBe(5001);
    expect(o.line_items[1].product_id).toBe(5002);
    expect(o.line_items[0].additional_properties.omnivore.unmapped).toBeUndefined();
  });

  it('nombre que no casa: se conserva el comportamiento de siempre', () => {
    const t = openTicket();
    (t._embedded.items[0] as any).name = 'MOFONG'; // el POS lo truncó
    const o: any = convertOmnivoreOrderToMCMOrder(
      t, CONFIG_ON, omnivoreIdToProductId, productIdByName,
    );
    expect(o.line_items[0].product_id).toBe(10383); // cae al open product, como hoy
    expect(o.line_items[1].product_id).toBe(5002);
  });

  it('sin mapa de nombres no explota', () => {
    const o: any = convertOmnivoreOrderToMCMOrder(openTicket(), CONFIG_ON, omnivoreIdToProductId);
    expect(o.line_items[0].product_id).toBe(10383);
  });

  it('un menu_item que NO es open product no pasa por la resolución por nombre', () => {
    const t = openTicket();
    (t._embedded.items[0] as any)._embedded.menu_item.id = '208';
    const map = new Map(omnivoreIdToProductId);
    map.set('208', 7777);
    const o: any = convertOmnivoreOrderToMCMOrder(t, CONFIG_ON, map, productIdByName);
    expect(o.line_items[0].product_id).toBe(7777);
  });
});

describe('open product — helpers de config', () => {
  it('isOpenProductEnabled exige bandera + id', () => {
    expect(isOpenProductEnabled(CONFIG_OFF)).toBe(false);
    expect(isOpenProductEnabled({ omnivoreOpenProductEnabled: true })).toBe(false);
    expect(isOpenProductEnabled(CONFIG_ON)).toBe(true);
  });

  it('getConfiguredOpenProductIds junta el default y los del mapeo', () => {
    expect(getConfiguredOpenProductIds(CONFIG_OFF).size).toBe(0);
    const ids = getConfiguredOpenProductIds(CONFIG_ON);
    expect([...ids].sort()).toEqual([OPEN_FOOD, OPEN_LIQUOR].sort());
  });

  it('normalizeOpenProductName colapsa espacios y baja a minúsculas', () => {
    expect(normalizeOpenProductName('  Mofongo   Relleno ')).toBe('mofongo relleno');
    expect(normalizeOpenProductName(null)).toBe('');
  });
});
