/**
 * A9 — delta incremental de line items para el push a Clover.
 *
 * ANTES: `reconcile_items` hacía DELETE+RECREATE de TODO el conjunto en cada corrida
 * («reconcile DELETE+RECREATEs the whole line-item set every run», decía su propio
 * comentario). Eso reasigna un `line_item_id` nuevo a cada línea en cada push.
 *
 * POR QUÉ IMPORTA: el pull estampa `additional_properties.clover.line_item_id` en cada
 * línea MCM (order-mapper.ts) y ése es el ANCLA con la que el modo gestionado correlaciona
 * lo que hay en el POS con lo que hay en MCM. Si el push la reasigna en cada ciclo, el
 * merge ve «ninguna línea conocida»: marcaría TODAS las de MCM como anuladas en el
 * terminal y añadiría TODAS las de Clover como nuevas. Duplicación y anulaciones falsas,
 * en cada vuelta. Por eso el merge sí funciona en Omnivore: Omnivore añade y anula
 * puntualmente, nunca borra y recrea.
 *
 * AHORA: se emparejan las líneas existentes con las deseadas por FIRMA y sólo se tocan
 * las que sobran y las que faltan. Una línea que no cambia conserva su id de Clover.
 *
 * La firma incluye tasas y modificadores a propósito:
 *  - el reparto de impuesto puede dar a una línea un céntimo más que a su gemela
 *    (clover-helper.ts lo documenta), así que dos líneas «iguales» pueden no serlo;
 *  - si cambian los modificadores de una línea, tiene que contar como línea distinta.
 *
 * Emparejamiento por MULTICONJUNTO, no por índice: una línea MCM con cantidad N se
 * empuja como N líneas de Clover idénticas, y el orden de respuesta de
 * `bulk_line_items` no está garantizado.
 *
 * MODO DE FALLO SEGURO: si las firmas no casan por lo que sea (Clover normaliza un
 * campo, cambia una tasa), nada empareja y el resultado degrada exactamente al
 * comportamiento anterior — borrar todo y recrear. Nunca deja la orden a medias.
 */

export interface CloverExistingLineItem {
  id: string;
  name?: string;
  note?: string;
  price?: number;
  taxRates?: { elements?: unknown[] } | unknown[];
  modifications?: { elements?: unknown[] } | unknown[];
}

export interface CloverDesiredLineItem {
  name?: string;
  note?: string;
  price?: number;
  taxRates?: unknown[];
  /** Campo propio nuestro (no de Clover): se aplica aparte vía /modifications. */
  modifiers?: unknown[];
  [k: string]: unknown;
}

export interface LineItemDelta {
  /** Líneas de Clover que se conservan tal cual (id → índice de la deseada que cubre). */
  keep: Array<{ cloverId: string; desiredIndex: number }>;
  /** Ids de Clover a borrar (sobran). */
  toDelete: string[];
  /** Índices de `desired` que hay que crear (faltan). */
  toCreateIndexes: number[];
}

const elements = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray((v as any).elements)) return (v as any).elements;
  return [];
};

/**
 * Firma estable de una tasa. Clover devuelve más campos de los que enviamos
 * (`name`, `rate`, …), así que sólo se comparan los que nosotros controlamos:
 * el id de la tasa y el importe aplicado.
 */
const taxSig = (raw: unknown[]): string =>
  raw
    .map((t: any) => {
      const id = t?.id ?? t?.taxRate?.id ?? '';
      const amt = t?.taxAmount ?? t?.tax_amount ?? '';
      return `${String(id)}~${String(amt)}`;
    })
    .sort()
    .join(',');

/** Firma de modificadores: id del modificador de catálogo + importe. */
const modSig = (raw: unknown[]): string =>
  raw
    .map((m: any) => {
      const id = m?.modifier?.id ?? m?.id ?? '';
      const amt = m?.amount ?? '';
      return `${String(id)}~${String(amt)}`;
    })
    .sort()
    .join(',');

const norm = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export const signatureOfExisting = (li: CloverExistingLineItem): string =>
  [
    norm(li.name),
    norm(li.price),
    norm(li.note),
    taxSig(elements(li.taxRates)),
    modSig(elements(li.modifications)),
  ].join('|');

export const signatureOfDesired = (li: CloverDesiredLineItem): string =>
  [
    norm(li.name),
    norm(li.price),
    norm(li.note),
    taxSig(Array.isArray(li.taxRates) ? li.taxRates : []),
    modSig(Array.isArray(li.modifiers) ? li.modifiers : []),
  ].join('|');

/**
 * Empareja lo que Clover tiene con lo que se quiere, y devuelve qué conservar,
 * qué borrar y qué crear. Puro y determinista.
 */
export function computeLineItemDelta(
  existing: CloverExistingLineItem[],
  desired: CloverDesiredLineItem[]
): LineItemDelta {
  const bySig = new Map<string, string[]>();
  for (const li of existing) {
    if (!li?.id) continue;
    const s = signatureOfExisting(li);
    const bucket = bySig.get(s);
    if (bucket) bucket.push(li.id);
    else bySig.set(s, [li.id]);
  }

  const keep: Array<{ cloverId: string; desiredIndex: number }> = [];
  const toCreateIndexes: number[] = [];

  desired.forEach((li, i) => {
    const bucket = bySig.get(signatureOfDesired(li));
    const cloverId = bucket && bucket.length > 0 ? bucket.shift() : undefined;
    if (cloverId) keep.push({ cloverId, desiredIndex: i });
    else toCreateIndexes.push(i);
  });

  // Lo que quede sin reclamar en los buckets sobra en Clover.
  const toDelete: string[] = [];
  for (const bucket of bySig.values()) toDelete.push(...bucket);

  return { keep, toDelete, toCreateIndexes };
}
