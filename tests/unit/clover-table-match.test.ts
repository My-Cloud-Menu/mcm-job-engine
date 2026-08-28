import { describe, it, expect } from 'vitest';
import {
  esTituloEscritoPorMCM,
  referenciaDeMesa,
  resolverMesaDesdeTitulo,
} from '../../src/handlers/clover/sync/table-match';

// Las mesas REALES del plano de Clover de Guajataca: se llaman "1".."10", sin prefijo.
const MESAS = Array.from({ length: 10 }, (_, i) => ({
  id: `uuid-${i + 1}`,
  table_name: String(i + 1),
  table_number: String(i + 1),
  revenue_center_id: null,
}));

describe('emparejar el titulo de Clover con una mesa — espejo del edge', () => {
  it('REGRESION: el terminal titula "Mesa 5" y la mesa se llama "5" -> casa', () => {
    expect(resolverMesaDesdeTitulo('Mesa 5', MESAS)?.id).toBe('uuid-5');
  });

  it('aguanta cualquier prefijo (idioma/version del terminal)', () => {
    expect(resolverMesaDesdeTitulo('Table 5', MESAS)?.id).toBe('uuid-5');
    expect(resolverMesaDesdeTitulo('MESA  5', MESAS)?.id).toBe('uuid-5');
    expect(resolverMesaDesdeTitulo('Mesa 10', MESAS)?.id).toBe('uuid-10');
    expect(resolverMesaDesdeTitulo('Mesa 05', MESAS)?.id).toBe('uuid-5');
  });

  it('ANTI-BUCLE: los titulos que escribe MCM no casan nunca', () => {
    // Sin la guarda, el numero final seria el ID DE LA ORDEN, no el de la mesa.
    expect(resolverMesaDesdeTitulo('1 · #10014', MESAS)).toBeNull();
    expect(resolverMesaDesdeTitulo('Mesa 5 · #10015', MESAS)).toBeNull();
    expect(resolverMesaDesdeTitulo('Room 200 · #10009', MESAS)).toBeNull();
    expect(resolverMesaDesdeTitulo('MCM #10677', MESAS)).toBeNull();
    expect(esTituloEscritoPorMCM('Mesa 5')).toBe(false);
  });

  it('un titulo libre no casa: mejor sin mesa que con la equivocada', () => {
    expect(resolverMesaDesdeTitulo('Cumpleanos Juan', MESAS)).toBeNull();
    expect(resolverMesaDesdeTitulo('Mesa 5A', MESAS)).toBeNull();
    expect(resolverMesaDesdeTitulo('Mesa 12', MESAS)).toBeNull();
    expect(resolverMesaDesdeTitulo(null, MESAS)).toBeNull();
  });

  it('el nombre exacto gana sobre el numero', () => {
    const mesas = [
      { id: 'u-a', table_name: 'Terraza 1', table_number: '1' },
      { id: 'u-b', table_name: '1', table_number: '9' },
    ];
    expect(resolverMesaDesdeTitulo('Terraza 1', mesas)?.id).toBe('u-a');
  });

  it('referenciaDeMesa devuelve el NUMERO, nunca la etiqueta', () => {
    // La interfaz compone `Mesa ${experience_reference}`: guardar "Mesa 5" daria "Mesa Mesa 5".
    expect(referenciaDeMesa({ id: 'u', table_name: 'Mesa 5', table_number: '5' })).toBe('5');
    expect(referenciaDeMesa({ id: 'u-x', table_name: 'Barra' })).toBe('u-x');
  });
});

describe('convertCloverOrderToMCMOrder — el titulo del terminal se conserva', () => {
  it('guarda clover_title, y no crea la clave si no hay titulo', async () => {
    const { convertCloverOrderToMCMOrder } = await import('../../src/handlers/clover/sync/order-mapper');
    const base = { id: 'CLV', paymentState: 'OPEN', clientCreatedTime: 1700000000000, modifiedTime: 1700000000000, lineItems: { elements: [] } };
    expect(convertCloverOrderToMCMOrder({ ...base, title: 'Cumpleanos Juan' } as any).additional_properties)
      .toEqual({ clover_title: 'Cumpleanos Juan' });
    expect(convertCloverOrderToMCMOrder(base as any).additional_properties).toEqual({});
  });
});
