/**
 * Modo "Open Product" de Omnivore — parte del PULL.
 *
 * Con la bandera encendida, el edge inyecta TODAS las líneas bajo un producto global del POS
 * (`menu_item` fijo + `name` + `price_per_unit`). El constructor del cuerpo vive en
 * `mcm-edge-functions/supabase/functions/_shared/helpers/omnivore-open-product.ts`; el job-engine
 * solo necesita la parte del pull: reconocer esos ids para no mapear cada línea del ticket al
 * producto MCM "OPEN FOOD".
 *
 * Sin `omnivoreOpenProductEnabled` en `site_integrations.config` estas funciones devuelven un set
 * vacío y el pull se comporta exactamente como siempre.
 */

export type OmnivoreOpenTaxClass = 'standard' | 'reduced' | 'water';

export interface OmnivoreOpenProductConfig {
  omnivoreOpenProductEnabled?: boolean;
  omnivoreOpenProductId?: string;
  omnivoreOpenProductIdByTaxClass?: Partial<Record<OmnivoreOpenTaxClass, string>>;
}

const asTrimmedString = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value).trim();

export const isOpenProductEnabled = (config: unknown): boolean => {
  const c = (config ?? {}) as OmnivoreOpenProductConfig;
  return (
    c.omnivoreOpenProductEnabled === true &&
    asTrimmedString(c.omnivoreOpenProductId).length > 0
  );
};

/** El id por defecto + los del mapeo por tax_class. Vacío ⇒ el pull no cambia en nada. */
export const getConfiguredOpenProductIds = (config: unknown): Set<string> => {
  const c = (config ?? {}) as OmnivoreOpenProductConfig;
  const ids = new Set<string>();
  const push = (value: unknown) => {
    const v = asTrimmedString(value);
    if (v) ids.add(v);
  };
  push(c.omnivoreOpenProductId);
  for (const value of Object.values(c.omnivoreOpenProductIdByTaxClass ?? {})) push(value);
  return ids;
};

/** Normalización para casar el nombre que devuelve el POS con el del catálogo MCM. */
export const normalizeOpenProductName = (name: unknown): string =>
  asTrimmedString(name).toLowerCase().replace(/\s+/g, ' ');
