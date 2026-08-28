import { describe, it, expect } from 'vitest';
import { convertCloverOrderToMCMOrder } from '../../src/handlers/clover/sync/order-mapper';
import { cloverIdsOf } from '../../src/handlers/clover/sync/managed-merge';

/**
 * BUG CRITICO 2026-08-28 — firear duplicaba en Clover los items que ya venia del terminal.
 *
 * El sync escribe el ancla como `line_item_id` (SINGULAR) y `send-to-kitchen` comprobaba solo
 * `line_item_ids` (PLURAL), que solo aparece cuando corre el merge. En la ventana entre el pull y
 * el primer merge, firear RE-ENVIABA los items del terminal y los duplicaba en el ticket.
 * Medido en vivo: ticket `4QM8RX4EEN2XG`, 2 «Papas salteadas» acabaron siendo 4.
 *
 * Estos tests atan la SALIDA REAL del converter al helper que decide si una linea se re-envia.
 * Comprobar cada pieza por separado no habria cazado el fallo: el defecto estaba justo en la
 * costura entre las dos.
 */
const ordenDeClover = (lineas: any[]) => ({
  id: 'CLV1', total: null, paymentState: 'OPEN',
  clientCreatedTime: 1700000000000, modifiedTime: 1700000000000,
  lineItems: { elements: lineas },
});

describe('el fire no puede re-enviar lo que ya esta en el terminal', () => {
  it('REGRESION: una linea recien traida del sync YA cuenta como anclada', () => {
    const mcm = convertCloverOrderToMCMOrder(
      ordenDeClover([{ id: '8758GSW0DXZYT', name: 'Papas salteadas', price: 400 }]),
    );
    const linea = mcm.line_items[0];

    // Asi es EXACTAMENTE como la emite el sync: singular, sin el array plural.
    expect(linea.additional_properties.clover.line_item_id).toBe('8758GSW0DXZYT');
    expect(linea.additional_properties.clover.line_item_ids).toBeUndefined();

    // Y aun asi el helper la reconoce: es lo que impide el reenvio.
    expect(cloverIdsOf(linea).length).toBeGreaterThan(0);
    expect(cloverIdsOf(linea)).toEqual(['8758GSW0DXZYT']);
  });

  it('la comprobacion VIEJA (solo plural) NO la detectaba — asi se colaba', () => {
    const linea = convertCloverOrderToMCMOrder(
      ordenDeClover([{ id: 'X1', name: 'Papas', price: 400 }]),
    ).line_items[0] as any;

    const comprobacionVieja =
      Array.isArray(linea.additional_properties?.clover?.line_item_ids) &&
      linea.additional_properties.clover.line_item_ids.length > 0;

    expect(comprobacionVieja).toBe(false);          // <- el agujero
    expect(cloverIdsOf(linea).length > 0).toBe(true); // <- el arreglo
  });

  it('una linea con el ancla en PLURAL sigue excluida (conducta previa intacta)', () => {
    const linea: any = { id: 'l1', additional_properties: { clover: { line_item_ids: ['A', 'B'] } } };
    expect(cloverIdsOf(linea)).toEqual(['A', 'B']);
  });

  it('una linea creada en MCM, SIN ancla, SI se firea', () => {
    expect(cloverIdsOf({ id: 'l2' } as any)).toEqual([]);
    expect(cloverIdsOf({ id: 'l3', additional_properties: {} } as any)).toEqual([]);
    expect(cloverIdsOf({ id: 'l4', additional_properties: { clover: { origin: 'mcm' } } } as any)).toEqual([]);
  });

  it('el converter marca la procedencia como `pos`, y el fire ya no debe pisarla', () => {
    const linea = convertCloverOrderToMCMOrder(
      ordenDeClover([{ id: 'X2', name: 'Sopa', price: 300 }]),
    ).line_items[0];
    expect(linea.additional_properties.clover.origin).toBe('pos');
  });
});
