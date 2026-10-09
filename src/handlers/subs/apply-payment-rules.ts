// Reglas puras de `subs.apply_payment` (sin base de datos), para poder probarlas una por una.

/** Una unidad comprada = una suscripción. Su identidad dentro de la orden es (línea, unidad). */
export const unitKey = (lineItemId: unknown, unitIndex: number) => `${String(lineItemId ?? '')}:${unitIndex}`;

export interface ExistingUnit { line_item_id: string | null; unit_index: number | null }

/**
 * Qué unidades de la orden YA tienen suscripción (R2). Antes se miraba «¿la orden tiene alguna?»: si el job se caía
 * con 10 de 20 creadas, el reintento no creaba las otras 10 y el cliente pagaba 20 planes y recibía 10.
 *
 * `legacy = true` si alguna fila vieja no dice su línea/unidad: con esas no se puede saber qué falta, así que se
 * mantiene la conducta anterior (la orden se da por aplicada) en vez de arriesgar un duplicado.
 */
export function existingUnitKeys(rows: ExistingUnit[]): { legacy: boolean; keys: Set<string> } {
  const keys = new Set<string>();
  let legacy = false;
  for (const r of rows) {
    if (r.line_item_id == null || r.unit_index == null || !Number.isInteger(Number(r.unit_index))) { legacy = true; continue; }
    keys.add(unitKey(r.line_item_id, Number(r.unit_index)));
  }
  return { legacy, keys };
}

/** Métodos que dejan una tarjeta guardable: el cobro de las renovaciones puede ser automático. */
export const isCardMethod = (method: unknown) => /stripe|test_card/i.test(String(method ?? ''));

/**
 * Instrumento de Test Card listo para `subs_instruments` (R1). El CHECK de la tabla sólo admite `provider='stripe'`:
 * el cobrador de pruebas trabaja con ese proveedor y decide por el `pm_sandbox_<directiva>` (ver `charger/sandbox.ts`).
 */
export function testCardInstrument(raw: unknown): {
  provider: 'stripe'; connected_account_id: string; provider_customer_id: string; provider_pm_id: string;
  brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null;
} | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pm = String(r.provider_pm_id ?? '');
  if (!/^pm_sandbox_[a-z0-9_]+__tc\d+$/.test(pm)) return null;
  const month = Number(r.exp_month);
  const year = Number(r.exp_year);
  return {
    provider: 'stripe',
    connected_account_id: 'acct_sandbox_test_card',
    provider_customer_id: String(r.provider_customer_id ?? `cus_sandbox_${pm.split('__')[1] ?? 'tc'}`),
    provider_pm_id: pm,
    brand: r.brand ? String(r.brand) : null,
    last4: r.last4 ? String(r.last4).slice(-4) : null,
    exp_month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
    exp_year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null,
  };
}

/**
 * ¿El plan sirve para el modelo de este equipo? (misión iOTEK 2026-10-07, D-083). Un plan sin modelos sirve para cualquiera, y
 * un equipo sin modelo cargado se acepta como antes (lo completa la activación). Sólo se niega cuando los dos dicen algo y no
 * coinciden: pegar un plan de dashcam a un GPS dejaría al cliente pagando un servicio que su equipo no usa.
 */
export function modeloSirve(modelosDelPlan: readonly number[] | null | undefined, modeloDelEquipo: number | null | undefined): boolean {
  if (!modelosDelPlan || modelosDelPlan.length === 0) return true;
  if (modeloDelEquipo == null) return true;
  return modelosDelPlan.map(Number).includes(Number(modeloDelEquipo));
}
