import { describe, it, expect } from 'vitest';
import { mergeManagedOrderLineItems } from '../../src/handlers/omnivore/sync/merge-managed-order';

const mcmItem = (id: string, omniId?: string, status = 'sent', extra: any = {}) => ({
  id,
  product_id: extra.product_id ?? 1,
  quantity: extra.quantity ?? 1,
  notes: extra.notes ?? '',
  status,
  additional_properties: omniId
    ? { omnivore: { item_id: omniId, origin: 'mcm', sent_to_pos: true } }
    : {},
  ...extra,
});

const posItem = (omniId: string, extra: any = {}) => ({
  id: `lineitem-x`,
  product_id: extra.product_id ?? 1,
  quantity: extra.quantity ?? 1,
  notes: extra.notes ?? '',
  status: 'sent',
  additional_properties: { omnivore: { item_id: omniId, origin: 'pos', sent: true } },
  ...extra,
});

describe('mergeManagedOrderLineItems', () => {
  it('MATCHED: conserva la línea MCM (mismo id, no duplica)', () => {
    const existing = [mcmItem('mcm-1', 'O1')];
    const mapped = [posItem('O1')];
    const out = mergeManagedOrderLineItems(existing, mapped);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('mcm-1'); // conserva uuid MCM
    expect(out[0].additional_properties.omnivore.origin).toBe('mcm');
  });

  it('POS-ADD: un ítem rung en el terminal entra como línea nueva (origin pos)', () => {
    const existing = [mcmItem('mcm-1', 'O1')];
    const mapped = [posItem('O1'), posItem('O2', { product_id: 9, name: 'Terminal item' })];
    const out = mergeManagedOrderLineItems(existing, mapped);
    expect(out).toHaveLength(2);
    const added = out.find((i: any) => i.additional_properties?.omnivore?.item_id === 'O2');
    expect(added).toBeTruthy();
    expect(added.additional_properties.omnivore.origin).toBe('pos');
    expect(added.id).not.toBe('lineitem-x'); // uuid fresco
  });

  it('TERMINAL-VOID: ítem MCM con id ausente del ticket → voided', () => {
    const existing = [mcmItem('mcm-1', 'O1')];
    const mapped: any[] = []; // el ticket ya no tiene O1
    const out = mergeManagedOrderLineItems(existing, mapped);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('voided');
    expect(out[0].void_reason).toBe('voided at terminal');
  });

  it('MCM-UNFIRED: ítem nuevo sin firear se deja intacto (no se anula por ausencia)', () => {
    const existing = [mcmItem('mcm-1', undefined, 'new')];
    const mapped: any[] = [];
    const out = mergeManagedOrderLineItems(existing, mapped);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('new');
  });

  it('ADOPCIÓN POR FIRMA: un sent sin id que matchea firma adopta el omni id (no duplica)', () => {
    const existing = [mcmItem('mcm-1', undefined, 'sent', { product_id: 5, quantity: 2, notes: 'no onion' })];
    const mapped = [posItem('O9', { product_id: 5, quantity: 2, notes: 'no onion' })];
    const out = mergeManagedOrderLineItems(existing, mapped);
    expect(out).toHaveLength(1); // NO duplica
    expect(out[0].id).toBe('mcm-1');
    expect(out[0].additional_properties.omnivore.item_id).toBe('O9');
    expect(out[0].additional_properties.omnivore.origin).toBe('mcm');
  });

  it('mapeado SIN omnivore.item_id NO se appendea (no duplica cada ciclo)', () => {
    const existing = [mcmItem('mcm-1', 'O1')];
    const noId = { id: 'lineitem-z', product_id: 1, quantity: 1, notes: '', status: 'sent', additional_properties: { omnivore: { origin: 'pos', sent: true } } };
    const mapped = [posItem('O1'), noId as any];
    const first = mergeManagedOrderLineItems(existing, mapped);
    expect(first).toHaveLength(1); // solo el matcheado; el sin-id se descarta
    const second = mergeManagedOrderLineItems(first, mapped);
    expect(second).toHaveLength(1); // estable, no crece
  });

  const splitItem = (extra: any = {}) => ({
    id: 'mcm-guac',
    product_id: 10003,
    quantity: 2,
    notes: 'sin cebolla',
    status: 'sent',
    additional_properties: { omnivore: { item_id: 'O178', item_ids: ['O178', 'O181'], origin: 'mcm', sent_to_pos: true } },
    ...extra,
  });
  const posRow = (omniId: string) => ({
    id: `x-${omniId}`, product_id: 10003, quantity: 1, notes: '', status: 'sent',
    additional_properties: { omnivore: { item_id: omniId, origin: 'pos', sent: true } },
  });

  it('QTY-SPLIT: línea MCM con item_ids[] (qty=2 → 2 filas POS) NO se duplica', () => {
    const out = mergeManagedOrderLineItems([splitItem()], [posRow('O178'), posRow('O181')]);
    expect(out).toHaveLength(1); // una sola línea, no 3
    expect(out[0].id).toBe('mcm-guac');
    // estable en el segundo ciclo
    const second = mergeManagedOrderLineItems(out, [posRow('O178'), posRow('O181')]);
    expect(second).toHaveLength(1);
  });

  it('QTY-SPLIT TERMINAL-VOID: si TODAS las filas del split desaparecen → voided', () => {
    const out = mergeManagedOrderLineItems([splitItem()], []);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('voided');
  });

  it('QTY-SPLIT parcial: si queda UNA fila del split, la línea sigue viva (no se anula)', () => {
    const out = mergeManagedOrderLineItems([splitItem()], [posRow('O181')]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('sent');
    expect(out[0].id).toBe('mcm-guac');
  });

  it('idempotente: correr 2x produce el mismo set (matched estable)', () => {
    const existing = [mcmItem('mcm-1', 'O1'), mcmItem('mcm-2', 'O2')];
    const mapped = [posItem('O1'), posItem('O2')];
    const first = mergeManagedOrderLineItems(existing, mapped);
    const second = mergeManagedOrderLineItems(first, mapped);
    expect(second).toHaveLength(2);
    expect(second.map((i: any) => i.id).sort()).toEqual(['mcm-1', 'mcm-2']);
  });
});
