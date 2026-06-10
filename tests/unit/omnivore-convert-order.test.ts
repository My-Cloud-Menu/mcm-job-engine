import { describe, it, expect } from 'vitest';
import { convertOmnivoreOrderToMCMOrder } from '../../src/handlers/omnivore/sync/order-mapper';

const config = { standardProductsCategories: ['1003'] };

function sampleTicket(overrides: Record<string, any> = {}) {
  return {
    id: '537079',
    name: 'John',
    opened_at: 1_700_000_000,
    closed_at: 1_700_003_600,
    totals: { due: 0, paid: 2500, items: 2000, discounts: 0, service_charges: 300, tax: 200, total: 2500 },
    _embedded: {
      employee: { id: '200', first_name: 'Jane', last_name: 'Doe' },
      order_type: { id: '5', name: 'Dine In' },
      revenue_center: { id: '1' },
      table: { id: 'T1', name: 'Table 1' },
      items: [
        {
          name: 'Burger',
          comment: 'no onions',
          price: 1000,
          quantity: 2,
          _embedded: { menu_item: { id: '208', _embedded: { menu_categories: [{ id: '1003' }] } } },
        },
      ],
    },
    ...overrides,
  };
}

describe('convertOmnivoreOrderToMCMOrder', () => {
  it('maps a dine-in, fully-paid ticket', () => {
    const o = convertOmnivoreOrderToMCMOrder(sampleTicket(), config);

    expect(o.pos_id).toBe('537079');
    expect(o.channel).toBe('pos');
    expect(o.experience).toBe('qe'); // table present
    expect(o.experience_reference).toBe('Table 1');
    expect(o.payment_status).toBe('fulfilled'); // due == 0
    expect(o.status).toBe('check-closed');
    expect(o.customer.first_name).toBe('John');
    expect(o.employee).toMatchObject({ id: '200', first_name: 'Jane', last_name: 'Doe' });

    // totals are cents → dollars
    expect(o.subtotal).toBe(20);
    expect(o.total).toBe(25);
    expect(o.total_tax).toBe(2);
    expect(o.paid).toBe(25);

    // line item
    expect(o.line_items).toHaveLength(1);
    expect(o.line_items[0]).toMatchObject({
      name: 'Burger',
      price: '10.00',
      total: '20.00', // 1000 * 2 / 100
      quantity: 2,
      tax_class: 'standard', // category 1003 ∈ standardProductsCategories
      product_id: 208,
      notes: 'no onions',
    });

    // 3 tax lines (estatal / reducido / municipal)
    expect(o.tax_lines.map((t: any) => t.rate_code)).toEqual(['estatal-tax', 'reduced-tax', 'municipal-tax']);

    // dates from unix seconds → ISO
    expect(o.date_created).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(o.date_updated).toBe(new Date(1_700_003_600 * 1000).toISOString());
  });

  it('maps a pickup (no table), unpaid ticket', () => {
    const t = sampleTicket();
    delete (t._embedded as any).table;
    t.totals = { due: 2500, paid: 0, items: 2000, discounts: 0, service_charges: 300, tax: 200, total: 2500 };
    const o = convertOmnivoreOrderToMCMOrder(t, config);

    expect(o.experience).toBe('pu');
    expect(o.payment_status).toBe('not_fulfilled');
    expect(o.status).toBe('new-order');
  });

  it('classifies non-standard categories as reduced', () => {
    const t = sampleTicket();
    t._embedded.items[0]._embedded.menu_item._embedded.menu_categories = [{ id: '9999' }];
    const o = convertOmnivoreOrderToMCMOrder(t, config);
    expect(o.line_items[0].tax_class).toBe('reduced');
  });

  it('partial payment → partially_fulfilled', () => {
    const t = sampleTicket();
    t.totals = { due: 500, paid: 2000, items: 2000, discounts: 0, service_charges: 300, tax: 200, total: 2500 };
    const o = convertOmnivoreOrderToMCMOrder(t, config);
    expect(o.payment_status).toBe('partially_fulfilled');
  });

  it('maps item modifiers → attributes + omnivoreParams (real Omnivore shape)', () => {
    const t = sampleTicket();
    // "Tacos Al Pastor" with *Corn Tortilla (free) + Banderita (+$4.00) — the
    // item price (2100) is INCLUSIVE of the modifiers (base 1700 + 0 + 400).
    t._embedded.items = [
      {
        name: 'Tacos Al Pastor',
        comment: null,
        price: 2100,
        quantity: 1,
        _embedded: {
          menu_item: { id: '303136', _embedded: { menu_categories: [{ id: '9999' }] } },
          modifiers: [
            {
              id: '1048603',
              name: '*Corn Tortilla',
              price: 0,
              quantity: 1,
              comment: null,
              _embedded: {
                menu_modifier: { id: '303134', pos_id: '303134' },
                modifier_group: { id: '10084', pos_id: '10084', name: 'Tortilla Taco' },
                modifiers: [],
              },
            },
            {
              id: '1048604',
              name: 'Banderita',
              price: 400,
              quantity: 1,
              comment: null,
              _embedded: {
                menu_modifier: { id: '305130', pos_id: '305130' },
                modifier_group: { id: '10110', pos_id: '10110', name: 'Up Charge Tacos' },
                modifiers: [],
              },
            },
          ],
        },
      },
    ];

    const o = convertOmnivoreOrderToMCMOrder(t, config);
    const li = o.line_items[0];

    // price stays inclusive
    expect(li.price).toBe('21.00');

    // attributes (flat) carry name + price (dollars) — used by the Clover split
    expect(li.attributes).toHaveLength(2);
    expect(li.attributes[0]).toMatchObject({ value: '*Corn Tortilla', price: '0.00', label: 'Tortilla Taco' });
    expect(li.attributes[1]).toMatchObject({ value: 'Banderita', price: '4.00', label: 'Up Charge Tacos' });

    // omnivoreParams (re-injection contract) — modifier = menu_modifier.id
    expect(li.additional_properties.omnivoreParams).toEqual([
      { modifier: '303134', modifier_group: '10084', quantity: 1 },
      { modifier: '305130', modifier_group: '10110', quantity: 1 },
    ]);
  });

  it('leaves attributes empty + additional_properties {} when the item has no modifiers', () => {
    const o = convertOmnivoreOrderToMCMOrder(sampleTicket(), config);
    expect(o.line_items[0].attributes).toEqual([]);
    expect(o.line_items[0].additional_properties).toEqual({});
  });
});
