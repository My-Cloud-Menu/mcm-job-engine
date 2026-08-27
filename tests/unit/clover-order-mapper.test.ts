import { describe, it, expect } from 'vitest';
import { convertCloverOrderToMCMOrder } from '../../src/handlers/clover/sync/order-mapper';

const order = (lineItems: any[]) => ({
  id: 'CLV1', total: 1000, paymentState: 'OPEN', clientCreatedTime: 1700000000000, modifiedTime: 1700000000000,
  lineItems: { elements: lineItems },
});

describe('convertCloverOrderToMCMOrder — modifier + product_id mapping', () => {
  it('maps line-item modifications to attributes[] AND additional_properties.modifiers', () => {
    const mcm = convertCloverOrderToMCMOrder(order([
      { id: 'LI1', name: 'Veggie Panini', price: 430, item: { id: 'ITEM_A' },
        modifications: { elements: [{ modifier: { id: 'M1' }, name: 'Crossiant', amount: 50 }] } },
    ]));
    const li = mcm.line_items[0];
    expect(li.attributes).toEqual([{ id: 'M1', label: 'Crossiant', value: 'Crossiant', price: 0.5 }]);
    expect(li.additional_properties.modifiers).toEqual([{ id: 'M1', label: 'Crossiant', value: 'Crossiant', price: 0.5 }]);
    // `origin: 'pos'` por paridad con el mapper de Omnivore: la línea nace en el terminal.
    expect(li.additional_properties.clover).toEqual({ line_item_id: 'LI1', clover_item_id: 'ITEM_A', origin: 'pos' });
  });

  it('resolves product_id to the MCM product via productMap (else falls back to the Clover item id)', () => {
    const withMap = convertCloverOrderToMCMOrder(order([{ id: 'LI1', name: 'X', price: 100, item: { id: 'ITEM_A' } }]), new Map([['ITEM_A', 10117]]));
    expect(withMap.line_items[0].product_id).toBe('10117');
    const noMap = convertCloverOrderToMCMOrder(order([{ id: 'LI1', name: 'X', price: 100, item: { id: 'ITEM_A' } }]));
    expect(noMap.line_items[0].product_id).toBe('ITEM_A');
  });

  it('emits empty attributes when there are no modifications', () => {
    const mcm = convertCloverOrderToMCMOrder(order([{ id: 'LI1', name: 'Plain', price: 100, item: { id: 'ITEM_B' } }]));
    expect(mcm.line_items[0].attributes).toEqual([]);
    expect(mcm.line_items[0].additional_properties.modifiers).toEqual([]);
  });

  it('still maps totals/status/clover_pos_id correctly (regression)', () => {
    const mcm = convertCloverOrderToMCMOrder(order([{ id: 'LI1', name: 'X', price: 1000, item: { id: 'A' } }]));
    expect(mcm.clover_pos_id).toBe('CLV1');
    expect(mcm.channel).toBe('pos');
    expect(mcm.total).toBe(10);
  });
});
