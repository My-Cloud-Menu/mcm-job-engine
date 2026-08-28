import { describe, it, expect } from 'vitest';
import {
  clasificarTasaClover,
  getTaxesBreakdownOfCloverOrder,
  modificacionesEnCentavos,
} from '../../src/handlers/clover/sync/tax-breakdown';

// Mapa real del banco de Clover: id de tasa -> rate_code de MCM.
const MAPA = {
  '348P6Q73G0JX8': 'estatal-tax',
  'AEYTXX25NKZKE': 'reduced-tax',
  'BHNNEH2NBTGHA': 'municipal-tax',
};

// FIXTURE REAL: la orden 6A56RF2C8DBKP tal como la devuelve Clover — un Espresso exento
// (NO_TAX_APPLIED) con modificador, y una sopa con estatal + municipal.
const ordenReal = {
  lineItems: {
    elements: [
      {
        name: 'Espresso',
        price: 199,
        modifications: { elements: [{ name: 'Iced', amount: 0 }, { name: 'Torani', amount: 45 }] },
        taxRates: { elements: [{ id: '81HRJNF07G2Z4', name: 'NO_TAX_APPLIED', rate: 0 }] },
      },
      {
        name: 'Soup of Day',
        price: 350,
        taxRates: {
          elements: [
            { id: '348P6Q73G0JX8', name: 'estatal', rate: 1050000 },
            { id: 'BHNNEH2NBTGHA', name: 'municipal', rate: 100000 },
          ],
        },
      },
    ],
  },
};

const porCodigo = (lineas: any[], code: string) => lineas.find((l) => l.rate_code === code);

describe('clover tax breakdown — espejo del edge', () => {
  it('REGRESION: la tasa "municipal" no se contabiliza como estatal', () => {
    const t = getTaxesBreakdownOfCloverOrder(ordenReal, MAPA);
    expect(porCodigo(t, 'municipal-tax').tax_total).toBe('0.04');
    expect(porCodigo(t, 'municipal-tax').subtotal).toBe(3.5);
    expect(porCodigo(t, 'estatal-tax').tax_total).toBe('0.37');
  });

  it('REGRESION: la base gravable ya no se infla (era 8.99 con 5.94 de mercancia)', () => {
    const t = getTaxesBreakdownOfCloverOrder(ordenReal, MAPA);
    expect(porCodigo(t, 'estatal-tax').subtotal).toBe(3.5);
  });

  it('una tasa de 0% no grava ni entra en ninguna base', () => {
    expect(clasificarTasaClover({ id: 'X', name: 'NO_TAX_APPLIED', rate: 0 }, MAPA)).toBeNull();
    expect(clasificarTasaClover({ id: 'X', name: 'estatal', rate: 0 }, MAPA)).toBeNull();
  });

  it('clasifica por ID aunque el nombre sea enganoso', () => {
    expect(
      clasificarTasaClover({ id: 'BHNNEH2NBTGHA', name: 'Impuesto general', rate: 100000 }, MAPA),
    ).toBe('municipal-tax');
  });

  it('sin mapa cae al respaldo por nombre y reconoce "municipal"', () => {
    expect(clasificarTasaClover({ id: 'Z', name: 'municipal', rate: 100000 }, null)).toBe('municipal-tax');
    expect(clasificarTasaClover({ id: 'Z', name: 'City Tax', rate: 100000 }, null)).toBe('municipal-tax');
    expect(clasificarTasaClover({ id: 'Z', name: 'Reduced', rate: 600000 }, null)).toBe('reduced-tax');
    expect(clasificarTasaClover({ id: 'Z', name: 'estatal', rate: 1050000 }, null)).toBe('estatal-tax');
  });

  it('una tasa desconocida con rate>0 sigue cayendo en estatal', () => {
    expect(clasificarTasaClover({ id: '?', name: 'Cualquier cosa', rate: 1050000 }, MAPA)).toBe('estatal-tax');
  });

  it('la base incluye los modificadores, igual que el calculador de MCM', () => {
    const conMods = {
      lineItems: {
        elements: [{
          name: 'Cafe', price: 199,
          modifications: { elements: [{ name: 'Extra', amount: 160 }] },
          taxRates: { elements: [{ id: '348P6Q73G0JX8', name: 'estatal', rate: 1050000 }] },
        }],
      },
    };
    const t = getTaxesBreakdownOfCloverOrder(conMods, MAPA);
    expect(porCodigo(t, 'estatal-tax').subtotal).toBe(3.59);
    expect(porCodigo(t, 'estatal-tax').tax_total).toBe('0.38');
  });

  it('modificacionesEnCentavos suma y tolera la ausencia del campo', () => {
    expect(modificacionesEnCentavos({ modifications: { elements: [{ amount: 45 }, { amount: 5 }] } })).toBe(50);
    expect(modificacionesEnCentavos({})).toBe(0);
  });

  it('la forma de salida no cambia: 3 filas, mismos rate_code y label', () => {
    const t = getTaxesBreakdownOfCloverOrder(ordenReal, MAPA);
    expect(t.map((l) => l.rate_code)).toEqual(['estatal-tax', 'reduced-tax', 'municipal-tax']);
    expect(t.map((l) => l.label)).toEqual(['Tax Estatal', 'Tax Reducido', 'Tax Municipal']);
  });
});

describe('convertCloverOrderToMCMOrder — precio con modificadores', () => {
  it('REGRESION: price y total incluyen los modificadores; product_price sigue siendo la base', async () => {
    const { convertCloverOrderToMCMOrder } = await import('../../src/handlers/clover/sync/order-mapper');
    const mcm = convertCloverOrderToMCMOrder({
      id: 'CLV9', paymentState: 'OPEN', clientCreatedTime: 1700000000000, modifiedTime: 1700000000000,
      lineItems: { elements: [{
        id: 'LI1', name: 'Espresso', price: 199,
        modifications: { elements: [{ modifier: { id: 'M1' }, name: 'Extra Shot', amount: 160 }] },
      }] },
    });
    const li = mcm.line_items[0];
    expect(li.price).toBe('3.59');
    expect(li.total).toBe('3.59');
    expect(li.product_price).toBe('1.99');
    // Y el total de la orden (respaldo, Clover no da `total`) tambien los suma.
    expect(mcm.total).toBe(3.59);
  });
});
