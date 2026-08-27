/**
 * Campos COSMÉTICOS que MCM puede sobrescribir y que el sync de Clover debe respetar.
 *
 * El catálogo es Clover → MCM y punto: no hay una sola escritura hacia `/items`, `/categories`
 * ni `/modifier_groups`. Pero eso hacía que un nombre o una descripción retocados en MCM se
 * perdieran en la siguiente corrida. Esto los protege.
 *
 * **Cómo se detecta el override, sin que el dashboard tenga que marcar nada.** Se guarda en
 * `additional_properties.cloverBaseline` lo ÚLTIMO que mandó Clover. En cada sync:
 *
 *   - valor de MCM  ==  línea base  → nadie tocó nada → gana Clover.
 *   - valor de MCM  !=  línea base  → alguien editó en MCM → **gana MCM**, y queda anotado en
 *     `additional_properties.cloverOverrides`.
 *
 * La línea base **siempre** se actualiza al valor nuevo de Clover. Eso da la vía de escape
 * natural: si alguien vuelve a poner en MCM lo mismo que dice Clover, deja de haber override y
 * Clover recupera el mando solo.
 *
 * **Arranque (sin línea base todavía).** Si los valores difieren se trata como override y se
 * conserva el de MCM. Es deliberado: con el sync corriendo, una diferencia sólo puede venir de
 * una edición local — si no, ya habrían convergido. Y si me equivoco, el fallo es **visible**
 * (queda en `cloverOverrides`) y reversible, mientras que adoptar el de Clover borraría el
 * trabajo de alguien en silencio y sin rastro.
 *
 * **Escape explícito:** poner `additional_properties.cloverAdoptOnNextSync = true` hace que la
 * siguiente corrida adopte los valores de Clover y borre la marca. Es el "volver a lo de Clover"
 * para el dashboard.
 *
 * Qué NO se protege, y por qué: `price`, `tax_class` e `is_taxable` son DINERO (si MCM diverge, el
 * ticket deja de cuadrar con Clover); `stock_status` es el 86 y tiene que seguir al POS en tiempo
 * real; `sku` es identidad, no cosmética.
 */

export const CAMPOS_PROTEGIDOS = {
  products: ['name', 'description'] as const,
  categories: ['name'] as const,
  ingredients: ['name'] as const,
  ingredients_groups: ['name', 'label'] as const,
};

export interface ResultadoOverrides<T> {
  /** `base` con los campos protegidos revertidos al valor de MCM cuando hay override. */
  base: T;
  /** Nombres de los campos que quedaron bajo control de MCM. */
  overrides: string[];
}

/**
 * @param campos   los campos protegidos de esta entidad
 * @param prev     la fila que ya existe en MCM (null si es alta)
 * @param base     lo que Clover quiere escribir; se devuelve ajustado
 * @param ap       `additional_properties` que se va a guardar — SE MUTA (baseline y overrides)
 * @param activo   la bandera de site; con `false` esto es un no-op y todo queda como antes
 */
export function aplicarOverridesLocales<T extends Record<string, any>>(
  campos: readonly string[],
  prev: Record<string, any> | null | undefined,
  base: T,
  ap: Record<string, any>,
  activo: boolean,
): ResultadoOverrides<T> {
  // Con la bandera APAGADA esto es un no-op absoluto: ni siquiera se escribe la línea base. Se
  // consideró registrarla igualmente "por si acaso", pero eso le costaría a TODO site una
  // escritura por fila en el primer sync tras desplegar, sin que nadie se lo haya pedido. Al
  // encender la bandera, el arranque sin línea base ya hace lo correcto: trata las diferencias
  // que encuentre como ediciones locales y las respeta.
  if (!activo) return { base, overrides: [] };

  const nuevaBaseline: Record<string, string> = {};
  for (const c of campos) nuevaBaseline[c] = String(base[c] ?? '');

  if (!prev) {
    ap.cloverBaseline = nuevaBaseline;
    delete ap.cloverOverrides;
    delete ap.cloverAdoptOnNextSync;
    return { base, overrides: [] };
  }

  const apPrev = ap;   // ya viene fusionado con el anterior por el llamador
  const baselinePrev: Record<string, string> | null = apPrev.cloverBaseline ?? null;
  const adoptar = apPrev.cloverAdoptOnNextSync === true;

  const overrides: string[] = [];
  const ajustado: Record<string, any> = { ...base };

  if (!adoptar) {
    for (const c of campos) {
      const enMcm = String(prev[c] ?? '');
      const enClover = String(base[c] ?? '');
      const enBaseline = baselinePrev ? String(baselinePrev[c] ?? '') : null;
      // Con línea base: hay override si MCM se apartó de ella.
      // Sin línea base (arranque): hay override si MCM y Clover ya difieren.
      const hayOverride = enBaseline !== null ? enMcm !== enBaseline : enMcm !== enClover;
      if (hayOverride) { ajustado[c] = prev[c]; overrides.push(c); }
    }
  }

  ap.cloverBaseline = nuevaBaseline;
  if (overrides.length > 0) ap.cloverOverrides = overrides;
  else delete ap.cloverOverrides;
  delete ap.cloverAdoptOnNextSync;

  return { base: ajustado as T, overrides };
}
