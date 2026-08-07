import { describe, it, expect } from 'vitest';
import { convertOmnivoreOrderToMCMOrder } from '../../src/handlers/omnivore/sync/order-mapper';

/**
 * Desglose de impuestos de una orden de Omnivore.
 *
 * `total_tax` viene DIRECTO del POS (`order-mapper.ts`: `omnivoreOrder.totals.tax / 100`),
 * mientras `tax_lines` es una reconstrucción de MCM. Hasta el 2026-08-07 la reconstrucción
 * calculaba `((base * 0.105) / 100).toFixed(2)`, y eso perdía el medio centavo SIEMPRE hacia
 * abajo: `700 × 0.105` son 73.5 centavos, pero `(0.735).toFixed(2)` da `"0.73"` porque en
 * binario 0.735 es 0.73499999999999998668.
 *
 * Consecuencia: `Σ tax_lines` quedaba por debajo del `total_tax` del POS, siempre en la misma
 * dirección — o sea, el desglose que alimenta la planilla de IVU declaraba de menos.
 *
 * Los tres casos de abajo son órdenes REALES de Pala Pizza (site 48372619) del 2026-08-07,
 * con los montos leídos de la base y del API de Omnivore.
 */

const CAT_STANDARD = '1003';
const config = { standardProductsCategories: [CAT_STANDARD] };

function item(name: string, priceCents: number, standard: boolean, id = String(Math.abs(priceCents))) {
  return {
    id,
    name,
    sent: true,
    price: priceCents,
    quantity: 1,
    _embedded: {
      menu_item: {
        id: `mi-${id}`,
        _embedded: { menu_categories: [{ id: standard ? CAT_STANDARD : '9999' }] },
      },
    },
  };
}

function ticket(items: any[], totals: Record<string, number>) {
  return {
    id: 'T-1',
    name: 'Prueba',
    opened_at: 1_700_000_000,
    totals: { due: 0, paid: 0, discounts: 0, service_charges: 0, ...totals },
    _embedded: {
      employee: { id: '975' },
      order_type: { id: '1', name: 'Dine In' },
      revenue_center: { id: '20' },
      items,
    },
  };
}

/** Σ de los tax_total del desglose, en centavos, sin punto flotante. */
function sumaDesglose(o: any): number {
  return (o.tax_lines || []).reduce(
    (a: number, t: any) => a + Math.round(Number(t.tax_total) * 100),
    0
  );
}

describe('tax_lines reconcilia con el total_tax del POS', () => {
  it('orden 10386 — un ítem de $7.00 standard (el medio centavo del estatal)', () => {
    // 700 × 10.5% = 73.5 centavos. Antes del fix: "0.73" → Σ 80, contra 81 del POS.
    const o = convertOmnivoreOrderToMCMOrder(
      ticket([item('Buccanera Can', 700, true)], { items: 700, tax: 81, total: 781 }),
      config
    );

    const linea = (code: string) => (o.tax_lines || []).find((t: any) => t.rate_code === code);
    expect(linea('estatal-tax').tax_total).toBe('0.74'); // era "0.73"
    expect(linea('municipal-tax').tax_total).toBe('0.07');

    expect(Math.round(Number(o.total_tax) * 100)).toBe(81); // del POS, intacto
    expect(sumaDesglose(o)).toBe(81); // ahora coincide
  });

  it('orden 10384 — dos ítems standard ($6.00 + $4.50), el medio centavo cae en el municipal', () => {
    // 1050 × 1% = 10.5 centavos. Antes del fix: "0.10" → Σ 120, contra 121 del POS.
    const o = convertOmnivoreOrderToMCMOrder(
      ticket([item('India Btl', 600, true), item('La H', 450, true)], {
        items: 1050,
        tax: 121,
        total: 1171,
      }),
      config
    );

    const linea = (code: string) => (o.tax_lines || []).find((t: any) => t.rate_code === code);
    expect(linea('estatal-tax').tax_total).toBe('1.10'); // 110.25 → 110, sin cambio
    expect(linea('municipal-tax').tax_total).toBe('0.11'); // era "0.10"

    expect(Math.round(Number(o.total_tax) * 100)).toBe(121);
    expect(sumaDesglose(o)).toBe(121);
  });

  it('orden 10383 — dos ítems reduced ($3.50 c/u): ya cuadraba y NO se mueve', () => {
    // Ninguna tasa cae en medio centavo (42 y 7 exactos) → el fix es un no-op aquí.
    const o = convertOmnivoreOrderToMCMOrder(
      ticket([item('Sprite', 350, false), item('Dasani', 350, false)], {
        items: 700,
        tax: 49,
        total: 749,
      }),
      config
    );

    const linea = (code: string) => (o.tax_lines || []).find((t: any) => t.rate_code === code);
    expect(linea('reduced-tax').tax_total).toBe('0.42');
    expect(linea('municipal-tax').tax_total).toBe('0.07');

    expect(Math.round(Number(o.total_tax) * 100)).toBe(49);
    expect(sumaDesglose(o)).toBe(49);
  });
});

describe('el redondeo es de centavos enteros, no de fracción', () => {
  it('el medio centavo sube, no baja', () => {
    // La regresión exacta: `(0.735).toFixed(2)` === "0.73" por el binario.
    expect((0.735).toFixed(2)).toBe('0.73'); // lo que hacía antes
    expect(Math.round(700 * 0.105)).toBe(74); // lo que hace ahora
  });

  it('el service charge usa el mismo redondeo', () => {
    // 350 × 11.5% = 40.25 → 40. Y un caso de medio centavo: 250 × 11.5% = 28.75 → 29.
    const o = convertOmnivoreOrderToMCMOrder(
      ticket([item('Plato', 1000, true)], { items: 1000, service_charges: 250, tax: 143, total: 1393 }),
      config
    );
    expect(o.fee_lines[0].total).toBe('2.50');
    expect(o.fee_lines[0].total_tax).toBe('0.29'); // Math.round(28.75) = 29
  });

  it('sin service charge no revienta ni emite NaN', () => {
    const o = convertOmnivoreOrderToMCMOrder(
      ticket([item('Plato', 500, true)], { items: 500, tax: 58, total: 558 }),
      config
    );
    expect(o.fee_lines[0].total_tax).toBe('0.00');
    expect(Number.isNaN(Number(o.fee_lines[0].total_tax))).toBe(false);
  });
});
