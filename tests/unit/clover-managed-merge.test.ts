import { describe, it, expect } from 'vitest';
import { mergeCloverManagedLineItems, lineSignature, cloverIdsOf } from '../../src/handlers/clover/sync/managed-merge';

/** Línea nacida en MCM (aún sin ancla) */
const mcm = (id: string, product_id: string, price: string, qty = 1, extra: any = {}) =>
  ({ id, product_id, name: `P${product_id}`, price, quantity: qty, notes: '', status: 'new', ...extra });

/** Línea tal como la devuelve el pull de Clover (1 fila = quantity 1) */
const pull = (cloverId: string, product_id: string, price: string, extra: any = {}) => ({
  id: `lineitem-${cloverId}`, product_id, name: `P${product_id}`, price, quantity: 1, notes: '',
  additional_properties: { modifiers: [], clover: { line_item_id: cloverId, clover_item_id: 'ITEM' } },
  ...extra,
});

const anclada = (id: string, product_id: string, price: string, ids: string[], qty = ids.length, extra: any = {}) =>
  ({ id, product_id, name: `P${product_id}`, price, quantity: qty, notes: '', status: 'sent',
     additional_properties: { clover: { line_item_ids: ids, line_item_id: ids[0] } }, ...extra });

describe('merge gestionado de Clover', () => {
  it('ARRANQUE EN FRÍO: tras el push, la línea MCM casa por firma y queda anclada', () => {
    const out = mergeCloverManagedLineItems([mcm('u1', '500', '2.50')], [pull('C1', '500', '2.50')]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('u1');                       // conserva su uuid
    expect(cloverIdsOf(out[0])).toEqual(['C1']);        // queda anclada
    expect(out[0].status).toBe('sent');
  });

  it('cantidad 3 se reconstituye como UNA línea con quantity 3, no como tres líneas', () => {
    const out = mergeCloverManagedLineItems(
      [mcm('u1', '500', '2.50', 3)],
      [pull('C1', '500', '2.50'), pull('C2', '500', '2.50'), pull('C3', '500', '2.50')]
    );
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(3);
    expect(cloverIdsOf(out[0]).sort()).toEqual(['C1', 'C2', 'C3']);
  });

  it('si en el terminal borran UNA de las tres, la cantidad baja a 2 (no se anula la línea)', () => {
    const out = mergeCloverManagedLineItems(
      [anclada('u1', '500', '2.50', ['C1', 'C2', 'C3'])],
      [pull('C1', '500', '2.50'), pull('C3', '500', '2.50')]
    );
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(2);
    expect(out[0].status).toBe('sent');
    expect(cloverIdsOf(out[0]).sort()).toEqual(['C1', 'C3']);
  });

  it('TERMINAL-VOID: tenía ancla y ya no queda ninguna fila suya', () => {
    const out = mergeCloverManagedLineItems([anclada('u1', '500', '2.50', ['C1'])], []);
    expect(out[0].status).toBe('voided');
    expect(out[0].void_reason).toBe('voided at terminal');
    expect(out[0].voided_at).toBeTruthy();
  });

  it('MCM-ONLY: una línea local sin ancla NUNCA se anula por ausencia', () => {
    const out = mergeCloverManagedLineItems([mcm('u1', '500', '2.50')], []);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('new');
    expect(out[0].void_reason).toBeUndefined();
  });

  it('POS-ADD: lo que añade el terminal entra como línea nueva marcada origin pos', () => {
    const out = mergeCloverManagedLineItems([], [pull('C9', '777', '9.00')]);
    expect(out).toHaveLength(1);
    expect(out[0].product_id).toBe('777');
    expect(out[0].additional_properties.clover.origin).toBe('pos');
    expect(out[0].status).toBe('sent');
  });

  it('POS-ADD agrupa por firma: 2 filas iguales del terminal = 1 línea con quantity 2', () => {
    const out = mergeCloverManagedLineItems([], [pull('C1', '777', '9.00'), pull('C2', '777', '9.00')]);
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(2);
    expect(cloverIdsOf(out[0]).sort()).toEqual(['C1', 'C2']);
  });

  it('EL CASO QUE MOTIVA TODO: local sin enviar + añadido en el terminal conviven', () => {
    const out = mergeCloverManagedLineItems(
      [mcm('u1', '500', '2.50'), mcm('u2', '600', '4.00')],   // u2 aún no empujada
      [pull('C1', '500', '2.50'), pull('C9', '777', '9.00')]  // el terminal añadió 777
    );
    expect(out).toHaveLength(3);
    const u1 = out.find((l) => l.id === 'u1')!;
    const u2 = out.find((l) => l.id === 'u2')!;
    const nueva = out.find((l) => l.product_id === '777')!;
    expect(cloverIdsOf(u1)).toEqual(['C1']);          // casó
    expect(u2.status).toBe('new');                     // intacta, NO anulada
    expect(nueva.additional_properties.clover.origin).toBe('pos');
  });

  it('el ancla gana sobre la firma: un cambio de precio en el terminal no rompe la identidad', () => {
    const out = mergeCloverManagedLineItems(
      [anclada('u1', '500', '2.50', ['C1'])],
      [pull('C1', '500', '9.99')]     // mismo id de Clover, otro precio
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('u1');
    expect(out[0].status).toBe('sent');
    expect(cloverIdsOf(out[0])).toEqual(['C1']);
  });

  it('una línea ya anulada se queda anulada (no revive ni se re-anula)', () => {
    const out = mergeCloverManagedLineItems(
      [anclada('u1', '500', '2.50', ['C1'], 1, { status: 'voided', voided_at: 'X' })], []
    );
    expect(out[0].status).toBe('voided');
    expect(out[0].voided_at).toBe('X');   // no se pisa el sello original
  });

  it('descarta una fila de Clover SIN id (no hay ancla ⇒ se re-appendearía cada ciclo)', () => {
    const sinId = { ...pull('X', '777', '9.00'), additional_properties: { modifiers: [], clover: { line_item_id: null } } };
    expect(mergeCloverManagedLineItems([], [sinId])).toEqual([]);
  });

  it('la firma es nombre+precio: son los unicos campos que hacen el viaje de ida y vuelta', () => {
    // product_id NO viaja (el push no manda referencia de catalogo) y notes tampoco
    // (el push serializa los modificadores dentro de la nota).
    const conProducto = lineSignature({ id: 'a', name: 'Café', price: '2.50', product_id: '500' } as any);
    const sinProducto = lineSignature({ id: 'b', name: 'Café', price: '2.50', product_id: '' } as any);
    expect(conProducto).toBe(sinProducto);
    expect(lineSignature({ id: 'c', name: 'Té', price: '2.50' } as any)).not.toBe(conProducto);
  });

  it('la firma normaliza el dinero: "2.5" y "2.50" son la misma línea', () => {
    const a = lineSignature({ id: 'a', name: 'X', price: '2.5' } as any);
    const b = lineSignature({ id: 'b', name: 'X', price: '2.50' } as any);
    expect(a).toBe(b);
  });

  it('entradas vacías o nulas no revientan', () => {
    expect(mergeCloverManagedLineItems(undefined, undefined)).toEqual([]);
    expect(mergeCloverManagedLineItems([], [])).toEqual([]);
  });

  it('IDEMPOTENTE: correr el merge dos veces con el mismo pull no cambia nada', () => {
    const pulled = [pull('C1', '500', '2.50'), pull('C2', '500', '2.50')];
    const uno = mergeCloverManagedLineItems([mcm('u1', '500', '2.50', 2)], pulled);
    const dos = mergeCloverManagedLineItems(uno, pulled);
    expect(dos).toHaveLength(1);
    expect(dos[0].id).toBe('u1');
    expect(dos[0].quantity).toBe(2);
    expect(cloverIdsOf(dos[0]).sort()).toEqual(['C1', 'C2']);
  });
});
