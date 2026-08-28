/**
 * Desglose de impuestos de una orden de Clover → las `tax_lines` de MCM.
 *
 * MIRROR de `mcm-edge-functions/supabase/functions/_shared/helpers/clover-tax-breakdown.ts`
 * (los dos repos no comparten código). Si cambia una, cambia la otra.
 */

/** Los tres cubos fiscales de MCM. `rate_code` es la clave con la que enganchan los informes
 *  (planilla SURI, exportación contable): NO cambiar estos literales. */
export type RateCode = 'estatal-tax' | 'reduced-tax' | 'municipal-tax';

/** Clover expresa la tasa como entero: 100 % = 10.000.000, así que 10,5 % = 1.050.000. */
const CLOVER_RATE_SCALE = 10_000_000;

/**
 * A qué cubo pertenece una tasa de Clover. El criterio ES EL ID, no el nombre: el nombre lo
 * escribe el comerciante y aquí la tasa municipal se llama literalmente `municipal`, mientras la
 * regla vieja buscaba `city` — así que la contaba como estatal.
 *
 * Devuelve `null` para las tasas de 0 % (`NO_TAX_APPLIED`), que antes caían en el cubo estatal y
 * sumaban su precio a la BASE gravable sin sumar impuesto, inflándola en silencio.
 */
export const clasificarTasaClover = (
  taxRate: any,
  idToCode?: Record<string, string> | null,
): RateCode | null => {
  const rate = Number(taxRate?.rate ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const id = String(taxRate?.id ?? '');
  const porId = id && idToCode ? idToCode[id] : undefined;
  if (porId === 'estatal-tax' || porId === 'reduced-tax' || porId === 'municipal-tax') {
    return porId;
  }

  const nombre = String(taxRate?.name ?? '').toLowerCase();
  if (nombre.includes('reduc')) return 'reduced-tax';
  if (nombre.includes('municipal') || nombre.includes('city')) return 'municipal-tax';
  return 'estatal-tax';
};

/** Σ de las modificaciones de una línea, en centavos. Clover las guarda APARTE del precio. */
export const modificacionesEnCentavos = (item: any): number =>
  ((item?.modifications?.elements ?? []) as any[]).reduce(
    (acc: number, m: any) => acc + Number(m?.amount ?? 0),
    0,
  );

/**
 * Construye las tres `tax_lines`. La forma de salida se mantiene EXACTAMENTE igual: los recibos
 * filtran por `tax_total > 0` y los informes agregan por `rate_code`.
 *
 * La base incluye las modificaciones, igual que hace el calculador de MCM.
 */
export const getTaxesBreakdownOfCloverOrder = (
  cloverOrder: any,
  idToCode?: Record<string, string> | null,
) => {
  const acc: Record<RateCode, { base: number; tax: number }> = {
    'estatal-tax': { base: 0, tax: 0 },
    'reduced-tax': { base: 0, tax: 0 },
    'municipal-tax': { base: 0, tax: 0 },
  };

  for (const item of (cloverOrder?.lineItems?.elements ?? []) as any[]) {
    const precio = Number(item?.price ?? 0) + modificacionesEnCentavos(item);
    for (const tr of (item?.taxRates?.elements ?? []) as any[]) {
      const code = clasificarTasaClover(tr, idToCode);
      if (!code) continue;
      acc[code].base += precio;
      acc[code].tax += precio * (Number(tr.rate) / CLOVER_RATE_SCALE);
    }
  }

  // `Math.round` sobre CENTAVOS enteros ANTES de dividir: el acumulador lleva fracciones de
  // centavo (700 × 0.105 = 73.5) y `(0.735).toFixed(2)` da "0.73" porque en binario es
  // 0.73499999999999998668 → el medio centavo caía SIEMPRE hacia abajo.
  const fila = (id: string, rate: string, label: string, rate_id: string, rate_code: RateCode) => ({
    id,
    rate,
    label,
    rate_id,
    compound: false,
    subtotal: acc[rate_code].base / 100,
    rate_code,
    tax_total: (Math.round(acc[rate_code].tax) / 100).toFixed(2),
    additional_properties: {},
  });

  return [
    fila('taxline-0', '10.5', 'Tax Estatal', '10001', 'estatal-tax'),
    fila('taxline-1', '6', 'Tax Reducido', '10002', 'reduced-tax'),
    fila('taxline-2', '1', 'Tax Municipal', '10004', 'municipal-tax'),
  ];
};
