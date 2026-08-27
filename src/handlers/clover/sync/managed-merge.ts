/**
 * Merge gestionado de Clover — el equivalente de `omnivore/sync/merge-managed-order.ts`,
 * adaptado al modelo de datos de Clover.
 *
 * QUÉ RESUELVE
 * El pull de Clover sobrescribía la orden entera. Con los dos lados escribiendo sobre la
 * misma mesa abierta (el mesero teclea en el dispositivo Clover Y en /pos-order), eso borra
 * lo que se acaba de añadir en MCM. Este merge es no destructivo, a nivel de línea.
 *
 * POR QUÉ NO ES UNA COPIA DEL DE OMNIVORE
 * Aloha parte una línea de cantidad N en N filas y MCM las espeja con `item_ids[]`.
 * Clover TAMBIÉN parte (el push emite N líneas de cantidad 1), pero el pull las trae 1:1
 * como N líneas MCM de cantidad 1. Si copiásemos el merge de Omnivore tal cual, una línea
 * de cantidad 3 se convertiría en tres líneas de cantidad 1 en el primer ciclo.
 * Aquí la correlación es por FIRMA + CANTIDAD: N filas de Clover con la misma firma
 * reconstituyen UNA línea MCM con `quantity = N`.
 *
 * CORRELACIÓN EN DOS PASADAS
 *   1ª por ANCLA  — `additional_properties.clover.line_item_ids[]` (ids reales de Clover).
 *                   Es exacta: sobrevive a cambios de precio hechos en el terminal.
 *   2ª por FIRMA  — `product_id|price|notes|modificadores`. Es la que hace el arranque en
 *                   frío: tras el primer push la línea MCM aún no tiene ancla, casa por
 *                   firma y queda anclada para los ciclos siguientes.
 *
 * CUATRO DESTINOS, como en Omnivore
 *   MATCHED       → se conserva la línea MCM (uuid, asiento, notas) y `quantity` pasa a ser
 *                   el número de filas que Clover tiene de verdad.
 *   TERMINAL-VOID → tenía ancla y ya no queda ninguna fila suya ⇒ la anularon en el terminal.
 *   MCM-ONLY      → nunca tuvo ancla ⇒ es local, aún no empujada. INTACTA, jamás se anula
 *                   por ausencia.
 *   POS-ADD       → filas de Clover que nadie reclamó ⇒ las añadió el terminal. Se agrupan
 *                   por firma en una sola línea MCM con su cantidad.
 *
 * Puro y determinista salvo `crypto.randomUUID()` para las líneas nuevas.
 */

export interface McmLineItem {
  id: string;
  product_id?: unknown;
  price?: unknown;
  quantity?: unknown;
  notes?: unknown;
  status?: string;
  attributes?: unknown[];
  additional_properties?: any;
  [k: string]: unknown;
}

/** Ids de Clover que una línea MCM ya tiene asociados (`line_item_ids[]` + el singular). */
export const cloverIdsOf = (li: McmLineItem | undefined): string[] => {
  const c = li?.additional_properties?.clover;
  if (!c) return [];
  const out: string[] = [];
  if (Array.isArray(c.line_item_ids)) for (const x of c.line_item_ids) if (x != null) out.push(String(x));
  if (c.line_item_id != null) { const s = String(c.line_item_id); if (!out.includes(s)) out.push(s); }
  return out;
};

const cloverIdOf = (li: McmLineItem | undefined): string | undefined => {
  const v = li?.additional_properties?.clover?.line_item_id;
  return v == null ? undefined : String(v);
};

const money = (v: unknown): string => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toFixed(2) : String(v ?? '');
};

/**
 * Firma con la que se correlaciona una línea MCM con una fila de Clover.
 *
 * SÓLO `name` + `price`, y no por pereza: son los ÚNICOS dos campos que hacen el viaje
 * de ida y vuelta intactos. Verificado contra el sandbox real:
 *
 *  · `product_id` NO viaja. El push crea las líneas con `bulk_line_items` pasando sólo
 *    `{name, price}`, sin referencia al catálogo de Clover, así que la fila no tiene
 *    `item.id` y el pull la devuelve con `product_id` vacío. Usarlo hacía que NADA
 *    emparejara: las 2 líneas de MCM sobrevivían intactas y las 3 de Clover entraban
 *    como añadidas en el terminal → 5 líneas donde debía haber 3.
 *  · `notes` NO viaja. El push serializa los modificadores DENTRO de la nota
 *    (`buildItemNote`), así que la nota de Clover ≠ la nota de MCM por construcción.
 *  · los modificadores tampoco: van dentro de esa misma nota, salvo con
 *    `cloverNativeModifiers` encendido.
 *
 * Es además la MISMA base que usa el delta del push (`line-item-delta.ts`), así que
 * las dos direcciones coinciden en qué considera «la misma línea».
 *
 * La imprecisión que queda —dos líneas con igual nombre y precio son intercambiables—
 * sólo afecta al arranque en frío: en cuanto la línea queda anclada, la 1ª pasada la
 * correlaciona por id exacto.
 */
export const lineSignature = (li: McmLineItem): string =>
  [String(li?.name ?? ''), money(li?.price)].join('|');

const qtyOf = (li: McmLineItem): number => {
  const n = Number(li?.quantity ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

export function mergeCloverManagedLineItems(
  existingInput: McmLineItem[] | undefined,
  pulledInput: McmLineItem[] | undefined
): McmLineItem[] {
  const existing = Array.isArray(existingInput) ? existingInput : [];
  const pulled = Array.isArray(pulledInput) ? pulledInput : [];

  // Pool de filas de Clover por reclamar.
  const pool = pulled.map((p) => ({ line: p, cloverId: cloverIdOf(p), claimed: false }));
  const claimedBy = new Map<string, typeof pool>();          // id de línea MCM → filas reclamadas

  const claim = (mcmId: string, entry: (typeof pool)[number]) => {
    entry.claimed = true;
    const arr = claimedBy.get(mcmId);
    if (arr) arr.push(entry);
    else claimedBy.set(mcmId, [entry]);
  };

  // ── 1ª pasada · por ANCLA (exacta) ────────────────────────────────────────
  for (const e of existing) {
    const anchors = cloverIdsOf(e);
    if (anchors.length === 0) continue;
    for (const entry of pool) {
      if (entry.claimed || !entry.cloverId) continue;
      if (anchors.includes(entry.cloverId)) claim(e.id, entry);
    }
  }

  // ── 2ª pasada · por FIRMA (arranque en frío y cambios de cantidad) ────────
  // Las ancladas van primero para que conserven su identidad antes que una gemela local.
  const porAncla = existing.filter((e) => cloverIdsOf(e).length > 0);
  const sinAncla = existing.filter((e) => cloverIdsOf(e).length === 0);
  for (const e of [...porAncla, ...sinAncla]) {
    const yaReclamadas = claimedBy.get(e.id)?.length ?? 0;
    let faltan = qtyOf(e) - yaReclamadas;
    if (faltan <= 0) continue;
    const sig = lineSignature(e);
    for (const entry of pool) {
      if (faltan <= 0) break;
      if (entry.claimed) continue;
      if (lineSignature(entry.line) !== sig) continue;
      claim(e.id, entry);
      faltan -= 1;
    }
  }

  // ── Resolver cada línea MCM ───────────────────────────────────────────────
  const result: McmLineItem[] = [];
  for (const e of existing) {
    const reclamadas = claimedBy.get(e.id) ?? [];
    const anchors = cloverIdsOf(e);

    if (reclamadas.length > 0) {
      // MATCHED — la cantidad la manda Clover (es quien tiene las filas de verdad).
      const ids = reclamadas.map((r) => r.cloverId).filter(Boolean) as string[];
      result.push({
        ...e,
        quantity: reclamadas.length,
        status: e.status === 'voided' ? 'voided' : 'sent',
        additional_properties: {
          ...(e.additional_properties ?? {}),
          clover: {
            ...(e.additional_properties?.clover ?? {}),
            line_item_ids: ids,
            line_item_id: ids[0] ?? e.additional_properties?.clover?.line_item_id ?? null,
          },
        },
      });
      continue;
    }

    if (anchors.length > 0 && e.status !== 'voided') {
      // TERMINAL-VOID — tenía filas en Clover y ya no queda ninguna.
      result.push({ ...e, status: 'voided', void_reason: 'voided at terminal', voided_at: new Date().toISOString() });
      continue;
    }

    // MCM-ONLY — nunca estuvo en Clover (o ya estaba anulada): INTACTA.
    result.push(e);
  }

  // ── POS-ADD · lo que nadie reclamó, agrupado por firma ────────────────────
  const huerfanas = pool.filter((p) => !p.claimed);
  const grupos = new Map<string, { line: McmLineItem; ids: string[] }>();
  for (const entry of huerfanas) {
    // Sin id de Clover no hay ancla idempotente: se descarta para no re-appendear en
    // cada ciclo y crecer sin límite. Mismo criterio que el merge de Omnivore.
    if (!entry.cloverId) continue;
    const sig = lineSignature(entry.line);
    const g = grupos.get(sig);
    if (g) g.ids.push(entry.cloverId);
    else grupos.set(sig, { line: entry.line, ids: [entry.cloverId] });
  }
  for (const { line, ids } of grupos.values()) {
    result.push({
      ...line,
      id: crypto.randomUUID(),
      quantity: ids.length,
      status: 'sent',
      additional_properties: {
        ...(line.additional_properties ?? {}),
        clover: { ...(line.additional_properties?.clover ?? {}), line_item_ids: ids, line_item_id: ids[0], origin: 'pos' },
      },
    });
  }

  return result;
}
