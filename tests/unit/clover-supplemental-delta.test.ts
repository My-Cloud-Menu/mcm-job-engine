import { describe, it, expect } from 'vitest';
import {
  chargeLineNames,
  isChargeLine,
  sumChargePrices,
  buildChargeDeltaLine,
  resolveSupplementTotal,
  absorbToTarget,
} from '../../src/handlers/clover/inject/supplemental';

/**
 * Banco del delta suplemental, anclado en la orden REAL 10343 del site de certificación
 * (99990003), que es la que destapó el bug.
 *
 * Estado observado en Clover antes del arreglo:
 *   MCM 8974  ·  primaria 4649 + suplemento 4280 = 8929   → faltaban 45
 *   ítems 8300 = 8300 ✓ · fee MCM 83 vs Clover 43 (−40) · tax 591 vs 586 (−5)
 *
 * El fee escala al 1 % del subtotal: creció de 43 a 83 mientras su CANTIDAD seguía en 1, así
 * que el delta por multiset lo veía como "sin cambio".
 */

const tax = (estatal: number, municipal: number) => [
  { id: '348P6Q73G0JX8', name: 'Tax Estatal', rate: 1050000, taxAmount: estatal },
  { id: 'BHNNEH2NBTGHA', name: 'Tax Municipal', rate: 100000, taxAmount: municipal },
];

const FEE_NAME = 'Maintenance & Entertainment Fee';

/** Payload congelado de la orden 10343 (7 líneas: 6 ítems + el fee ya crecido a 83). */
const FROZEN_10343 = [
  { name: 'Sopa de Tortilla', price: 1300, taxRates: tax(78, 13) },
  { name: 'Pozole Rojo Pollo', price: 1500, taxRates: tax(90, 15) },
  { name: 'Pozole Rojo Pollo', price: 1500, taxRates: tax(90, 15) },
  { name: 'Guacamole en Molcajete', price: 1800, taxRates: tax(108, 18) },
  { name: 'Refrito', price: 1100, taxRates: tax(66, 11) },
  { name: 'Refrito', price: 1100, taxRates: tax(66, 11) },
  { name: FEE_NAME, price: 83, taxRates: tax(9, 1) },
];

/** Lo que Clover tiene en la primaria: los 3 primeros ítems + el fee al valor VIEJO (43). */
const PRIMARY_CLOVER_LINES_10343 = [
  { name: 'Sopa de Tortilla', price: 1300 },
  { name: 'Pozole Rojo Pollo', price: 1500 },
  { name: 'Pozole Rojo Pollo', price: 1500 },
  { name: FEE_NAME, price: 43 },
];

const ORDER_10343 = { fee_lines: [{ name: FEE_NAME }], shipping_lines: [] };

/** Orden 10345 — la de la prueba en vivo. Mismo cargo, distinta corrida. */
const ORDER_10345 = { fee_lines: [{ name: FEE_NAME }], shipping_lines: [] };

describe('identificación de líneas de cargo', () => {
  it('toma los nombres de fee_lines y shipping_lines', () => {
    const names = chargeLineNames({
      fee_lines: [{ name: FEE_NAME }],
      shipping_lines: [{ name: 'Delivery' }],
    });
    expect([...names].sort()).toEqual(['Delivery', FEE_NAME]);
  });

  it('una orden sin cargos no marca ninguna línea (el camino queda intacto)', () => {
    const names = chargeLineNames({ fee_lines: [], shipping_lines: [] });
    expect(names.size).toBe(0);
    expect(FROZEN_10343.every((li) => !isChargeLine(li, names))).toBe(true);
  });

  it('suma sólo el price de las líneas de cargo', () => {
    const names = chargeLineNames(ORDER_10343);
    expect(sumChargePrices(FROZEN_10343, names)).toBe(83);
    expect(sumChargePrices(PRIMARY_CLOVER_LINES_10343, names)).toBe(43);
  });
});

describe('línea de diferencia del cargo', () => {
  const names = chargeLineNames(ORDER_10343);

  it('factura SÓLO lo que el fee creció (83 − 43 = 40), no el fee entero', () => {
    const line = buildChargeDeltaLine(FROZEN_10343, names, 43);
    expect(line).not.toBeNull();
    expect(line.price).toBe(40);
    // El nombre DEBE quedar idéntico: el siguiente suplemento suma los cargos ya
    // facturados por nombre, y renombrarla rompería esa suma.
    expect(line.name).toBe(FEE_NAME);
  });

  it('reparte el impuesto en proporción al precio, no lo recalcula sobre la diferencia', () => {
    const line = buildChargeDeltaLine(FROZEN_10343, names, 43);
    // share = 40/83 → estatal round(9 × 0.4819) = 4 · municipal round(1 × 0.4819) = 0
    expect(line.taxRates.map((t: any) => t.taxAmount)).toEqual([4, 0]);
  });

  it('no emite línea cuando el fee no cambió', () => {
    expect(buildChargeDeltaLine(FROZEN_10343, names, 83)).toBeNull();
  });

  it('no emite línea cuando el fee BAJÓ (no se factura negativo)', () => {
    expect(buildChargeDeltaLine(FROZEN_10343, names, 120)).toBeNull();
  });

  it('factura el fee completo cuando aparece por primera vez después del pago', () => {
    const line = buildChargeDeltaLine(FROZEN_10343, names, 0);
    expect(line.price).toBe(83);
    expect(line.taxRates.map((t: any) => t.taxAmount)).toEqual([9, 1]);
  });

  it('es un no-op literal en una orden sin cargos', () => {
    const sinCargo = chargeLineNames({ fee_lines: [], shipping_lines: [] });
    expect(buildChargeDeltaLine(FROZEN_10343, sinCargo, 0)).toBeNull();
  });
});

describe('total del suplemento = residual', () => {
  it('la orden 10343 cierra EXACTO: 4649 + 4325 = 8974', () => {
    const r = resolveSupplementTotal({
      orderTotalCents: 8974,
      billedCloverTotalCents: 4649,
      linesTotalCents: 4324,
    });
    expect(r.source).toBe('residual');
    expect(r.totalCents).toBe(4325);
    expect(4649 + r.totalCents).toBe(8974);
  });

  it('el residual manda sobre la suma de líneas cuando difieren por redondeo del tax', () => {
    // La itemización da 4324 (el reparto proporcional pierde 1 centavo); lo cobrado es 4325,
    // que es lo que realmente falta. El dinero lo fija el total, no la suma de líneas.
    const r = resolveSupplementTotal({
      orderTotalCents: 8974,
      billedCloverTotalCents: 4649,
      linesTotalCents: 4324,
    });
    expect(r.totalCents).not.toBe(4324);
    expect(r.totalCents).toBe(4325);
  });

  it('descuenta los suplementos previos: la cadena nunca re-cobra', () => {
    // primaria 4649 + suplemento previo 4325 → ya no falta nada
    const r = resolveSupplementTotal({
      orderTotalCents: 8974,
      billedCloverTotalCents: 4649 + 4325,
      linesTotalCents: 1000,
    });
    expect(r.totalCents).toBe(0);
  });

  it('residual ≤ 0 cuando Clover ya facturó de más → el llamador debe bloquear el cobro', () => {
    const r = resolveSupplementTotal({
      orderTotalCents: 8974,
      billedCloverTotalCents: 9500,
      linesTotalCents: 4000,
    });
    expect(r.source).toBe('residual');
    expect(r.totalCents).toBeLessThan(0);
  });

  it('el residual acota el cobro aunque el delta pida re-facturar la orden entera', () => {
    // Escenario del manifiesto perdido: el delta traería los 8300 de ítems otra vez.
    const r = resolveSupplementTotal({
      orderTotalCents: 8974,
      billedCloverTotalCents: 8929,
      linesTotalCents: 8300,
    });
    expect(r.totalCents).toBe(45); // no 8300
  });

  it('sin datos de Clover cae a la suma de líneas (comportamiento previo)', () => {
    expect(resolveSupplementTotal({ orderTotalCents: 8974, billedCloverTotalCents: null, linesTotalCents: 4280 }))
      .toMatchObject({ totalCents: 4280, source: 'lines', residualCents: null });
    expect(resolveSupplementTotal({ orderTotalCents: null, billedCloverTotalCents: 4649, linesTotalCents: 4280 }))
      .toMatchObject({ totalCents: 4280, source: 'lines' });
  });
});

/**
 * Clover COBRA la suma de las líneas, no `order.total`. Verificado en vivo con la orden MCM
 * 10345 / suplemento `Y6095EKT4P4P2`: Clover guardaba `total = 3892` (el residual correcto) y
 * el Flex cobró **3893**, que es lo que sumaban sus líneas → `orders.paid` 64.88 contra un
 * total de 64.87. Por eso la itemización tiene que cerrar al residual, no sólo el total.
 */
describe('la itemización se cuadra al residual (Clover cobra las líneas)', () => {
  const names = chargeLineNames(ORDER_10345);

  /** Las 3 líneas que se enviaron al suplemento de 10345 antes de absorber: suman 3893. */
  const LINEAS_10345 = [
    { name: 'Queso Fundido Asada', price: 1800, taxRates: tax(108, 18) },
    { name: 'Queso Fundido Asada', price: 1800, taxRates: tax(108, 18) },
    { name: FEE_NAME, price: 36, taxRates: tax(4, 1) },
  ];

  it('reproduce el centavo de más que se cobró en vivo', () => {
    const suma = LINEAS_10345.reduce(
      (a, li) => a + li.price + li.taxRates.reduce((x, t) => x + t.taxAmount, 0),
      0
    );
    expect(suma).toBe(3893); // lo que el Flex cobró
    expect(suma).not.toBe(3892); // lo que realmente faltaba
  });

  it('absorbe el centavo en la línea de cargo y deja la suma EXACTA', () => {
    const { lines, absorbedCents } = absorbToTarget(LINEAS_10345, 3892, names);
    expect(absorbedCents).toBe(-1);
    const suma = lines.reduce(
      (a: any, li: any) => a + li.price + (li.taxRates || []).reduce((x: number, t: any) => x + t.taxAmount, 0),
      0
    );
    expect(suma).toBe(3892);
    // El ajuste cae en el cargo, no en un ítem: los ítems del cliente no se tocan.
    expect(lines[2].price).toBe(35);
    expect(lines[0].price).toBe(1800);
    expect(lines[1].price).toBe(1800);
  });

  it('no toca nada cuando la suma ya es exacta', () => {
    const { lines, absorbedCents } = absorbToTarget(LINEAS_10345, 3893, names);
    expect(absorbedCents).toBe(0);
    expect(lines).toBe(LINEAS_10345);
  });

  it('cae a una línea de ítem cuando no hay cargo donde absorber', () => {
    const sinCargo = chargeLineNames({ fee_lines: [], shipping_lines: [] });
    const soloItems = LINEAS_10345.slice(0, 2);
    const { lines, absorbedCents } = absorbToTarget(soloItems, 3851, sinCargo);
    expect(absorbedCents).toBe(-1);
    expect(lines[1].price).toBe(1799);
  });

  it('nunca deja una línea en 0 o negativa (Clover las rechaza)', () => {
    const lineas = [{ name: FEE_NAME, price: 5, taxRates: tax(0, 0) }];
    const { lines, absorbedCents } = absorbToTarget(lineas, -100, names);
    expect(absorbedCents).toBe(0);
    expect(lines[0].price).toBe(5); // sin cambio → el llamador lo marca como no reconciliado
  });
});

describe('regresión: el camino de ítems no se movió', () => {
  const names = chargeLineNames(ORDER_10343);

  it('el suplemento de 10343 lleva los 3 ítems nuevos + la línea del cargo', () => {
    // Lo que la RPC devolvió como delta (ítems), más el cargo que ella no ve.
    const deltaDeLaRpc = FROZEN_10343.filter((li) =>
      ['Guacamole en Molcajete', 'Refrito'].includes(li.name)
    );
    const lines = [
      ...deltaDeLaRpc.filter((li) => !isChargeLine(li, names)),
      buildChargeDeltaLine(FROZEN_10343, names, 43),
    ];
    expect(lines).toHaveLength(4);
    expect(lines.map((l: any) => l.price)).toEqual([1800, 1100, 1100, 40]);
    // Los ítems viajan intactos: mismo objeto, mismos taxRates.
    expect(lines[0]).toBe(deltaDeLaRpc[0]);
  });

  it('una orden sin cargo produce EXACTAMENTE las líneas del delta, sin añadidos', () => {
    const sinCargo = chargeLineNames({ fee_lines: [], shipping_lines: [] });
    const delta = FROZEN_10343.slice(3, 6);
    const lines = delta.filter((li) => !isChargeLine(li, sinCargo));
    expect(lines).toEqual(delta);
    expect(buildChargeDeltaLine(FROZEN_10343, sinCargo, 0)).toBeNull();
  });
});
