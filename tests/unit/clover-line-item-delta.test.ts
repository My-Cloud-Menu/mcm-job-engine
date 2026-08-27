import { describe, it, expect } from 'vitest';
import { computeLineItemDelta, signatureOfDesired, signatureOfExisting } from '../../src/handlers/clover/inject/line-item-delta';

const ex = (id: string, name: string, price: number, extra: any = {}) => ({ id, name, price, ...extra });
const de = (name: string, price: number, extra: any = {}) => ({ name, price, ...extra });

describe('A9 · delta incremental de line items', () => {
  it('sin cambios: conserva TODO, no borra ni crea nada (el ancla sobrevive)', () => {
    const existing = [ex('L1', 'Café', 250), ex('L2', 'Tostada', 400)];
    const desired = [de('Café', 250), de('Tostada', 400)];
    const d = computeLineItemDelta(existing, desired);
    expect(d.toDelete).toEqual([]);
    expect(d.toCreateIndexes).toEqual([]);
    expect(d.keep.map((k) => k.cloverId).sort()).toEqual(['L1', 'L2']);
  });

  it('añadir un ítem: sólo crea el nuevo, conserva los demás', () => {
    const existing = [ex('L1', 'Café', 250)];
    const desired = [de('Café', 250), de('Zumo', 300)];
    const d = computeLineItemDelta(existing, desired);
    expect(d.keep).toEqual([{ cloverId: 'L1', desiredIndex: 0 }]);
    expect(d.toCreateIndexes).toEqual([1]);
    expect(d.toDelete).toEqual([]);
  });

  it('quitar un ítem: sólo borra ese id', () => {
    const existing = [ex('L1', 'Café', 250), ex('L2', 'Tostada', 400)];
    const desired = [de('Café', 250)];
    const d = computeLineItemDelta(existing, desired);
    expect(d.toDelete).toEqual(['L2']);
    expect(d.toCreateIndexes).toEqual([]);
  });

  it('subir cantidad de 2 a 3 conserva las 2 existentes y crea 1 (qty-split)', () => {
    // Una linea MCM con quantity:N se empuja como N lineas identicas.
    const existing = [ex('L1', 'Café', 250), ex('L2', 'Café', 250)];
    const desired = [de('Café', 250), de('Café', 250), de('Café', 250)];
    const d = computeLineItemDelta(existing, desired);
    expect(d.keep).toHaveLength(2);
    expect(d.toCreateIndexes).toEqual([2]);
    expect(d.toDelete).toEqual([]);
  });

  it('bajar cantidad de 3 a 1 conserva 1 y borra 2', () => {
    const existing = [ex('L1', 'Café', 250), ex('L2', 'Café', 250), ex('L3', 'Café', 250)];
    const desired = [de('Café', 250)];
    const d = computeLineItemDelta(existing, desired);
    expect(d.keep).toHaveLength(1);
    expect(d.toDelete).toHaveLength(2);
    expect(d.toCreateIndexes).toEqual([]);
  });

  it('cambiar el precio cuenta como linea distinta: borra la vieja y crea la nueva', () => {
    const d = computeLineItemDelta([ex('L1', 'Café', 250)], [de('Café', 300)]);
    expect(d.toDelete).toEqual(['L1']);
    expect(d.toCreateIndexes).toEqual([0]);
    expect(d.keep).toEqual([]);
  });

  it('cambiar la nota (modificadores en texto) cuenta como linea distinta', () => {
    const d = computeLineItemDelta(
      [ex('L1', 'Café', 250, { note: 'sin azucar' })],
      [de('Café', 250, { note: 'con leche' })]
    );
    expect(d.toDelete).toEqual(['L1']);
    expect(d.toCreateIndexes).toEqual([0]);
  });

  it('el centimo de diferencia del reparto de impuesto NO desempareja de mas', () => {
    // clover-helper reparte el impuesto y una gemela puede llevar un centimo mas.
    const existing = [
      ex('L1', 'Café', 250, { taxRates: { elements: [{ id: 'TR1', taxAmount: 29 }] } }),
      ex('L2', 'Café', 250, { taxRates: { elements: [{ id: 'TR1', taxAmount: 28 }] } }),
    ];
    const desired = [
      de('Café', 250, { taxRates: [{ id: 'TR1', taxAmount: 29 }] }),
      de('Café', 250, { taxRates: [{ id: 'TR1', taxAmount: 28 }] }),
    ];
    const d = computeLineItemDelta(existing, desired);
    expect(d.keep).toHaveLength(2);
    expect(d.toDelete).toEqual([]);
    expect(d.toCreateIndexes).toEqual([]);
  });

  it('si cambian los modificadores nativos, la linea se rehace (no se quedan viejos pegados)', () => {
    const existing = [ex('L1', 'Pizza', 1200, { modifications: { elements: [{ modifier: { id: 'M1' }, amount: 50 }] } })];
    const desired = [de('Pizza', 1200, { modifiers: [{ modifier: { id: 'M2' }, amount: 50 }] })];
    const d = computeLineItemDelta(existing, desired);
    expect(d.toDelete).toEqual(['L1']);
    expect(d.toCreateIndexes).toEqual([0]);
  });

  it('MODO DE FALLO SEGURO: si nada empareja, degrada a borrar todo y recrear', () => {
    const existing = [ex('L1', 'A', 1), ex('L2', 'B', 2)];
    const desired = [de('X', 9), de('Y', 8)];
    const d = computeLineItemDelta(existing, desired);
    expect(d.toDelete.sort()).toEqual(['L1', 'L2']);
    expect(d.toCreateIndexes).toEqual([0, 1]);
    expect(d.keep).toEqual([]);
  });

  it('orden vacia en Clover: crea todo, no borra nada', () => {
    const d = computeLineItemDelta([], [de('A', 1), de('B', 2)]);
    expect(d.toCreateIndexes).toEqual([0, 1]);
    expect(d.toDelete).toEqual([]);
  });

  it('vaciar la orden: borra todo, no crea nada', () => {
    const d = computeLineItemDelta([ex('L1', 'A', 1)], []);
    expect(d.toDelete).toEqual(['L1']);
    expect(d.toCreateIndexes).toEqual([]);
  });

  it('ignora una linea existente sin id (no se puede borrar ni casar)', () => {
    const d = computeLineItemDelta([{ id: '', name: 'A', price: 1 } as any], [de('A', 1)]);
    expect(d.toCreateIndexes).toEqual([0]);
    expect(d.toDelete).toEqual([]);
  });

  it('la firma es estable ante el orden de las tasas', () => {
    const a = signatureOfExisting(ex('L1', 'A', 1, { taxRates: { elements: [{ id: 'T2' }, { id: 'T1' }] } }));
    const b = signatureOfDesired(de('A', 1, { taxRates: [{ id: 'T1' }, { id: 'T2' }] }));
    expect(a).toBe(b);
  });

  it('la firma tolera taxRates como array plano o envuelto en {elements}', () => {
    const envuelto = signatureOfExisting(ex('L1', 'A', 1, { taxRates: { elements: [{ id: 'T1', taxAmount: 5 }] } }));
    const plano = signatureOfExisting(ex('L1', 'A', 1, { taxRates: [{ id: 'T1', taxAmount: 5 }] }));
    expect(envuelto).toBe(plano);
  });
});
