import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { HandlerError } from '../../../core/types';
import { enqueueCloverSupplementalInjection } from '../../../enqueue/helpers';
import { persistCloverHash, persistInjectionError } from './shared';

/**
 * "Supplemental Clover orders" — Clover's REST API cannot reopen or mutate a
 * PAID/locked order (verified: the `state` field is cosmetic, no reopen endpoint,
 * line items can't be added once a payment exists). So when items are added in
 * the source POS (Omnivore→MCM→Clover) AFTER the Clover order was paid, we bill
 * the NEW items on a SECOND ("supplemental") Clover order linked to the same MCM
 * order, instead of silently dropping them.
 *
 * State lives under `orders.additional_properties.clover_supplemental` (jsonb, no
 * migration). The delta (what to put on a new supplement) = the frozen Clover
 * line items not yet billed on the primary + prior supplements.
 */

export interface SupplementEntry {
  external_reference_id: string;
  clover_order_id: string | null;
  delta_signature: string;
  delta_keys: Record<string, number>;
  total_cents: number;
}

export interface SupplementalManifest {
  primary?: { clover_order_id?: string | null; billed_keys?: Record<string, number> };
  supplements?: SupplementEntry[];
}

/**
 * Stable, absorber-independent line key = `name || note`. The reconciliation
 * absorber (buildCloverLineItemsWithTaxes) can shift ONE line's price by a few
 * cents, so price is excluded from the key. `note` encodes the modifiers, so
 * items that differ only by modifier still get distinct keys. This key matches
 * between the frozen Clover payload and Clover-side GET line items (both carry
 * `name` + `note`), which is what lets us seed `billed_keys` for legacy orders.
 */
export function lineKey(li: any): string {
  return `${li?.name ?? ''}||${li?.note ?? ''}`;
}

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) hash = (hash * 33) ^ str.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

/** Supplemental order's own externalReferenceId (≤12 chars, Clover invoice limit). */
export function buildSupplementalExternalRef(siteId: number, orderId: unknown, deltaSig: string): string {
  return ('ms' + djb2(`${siteId}:${orderId}:${deltaSig}`)).slice(0, 12);
}

export function multisetFromLines(lines: any[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const li of lines || []) {
    const k = lineKey(li);
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function lineTotalCents(li: any): number {
  return (
    (li.price || 0) +
    (li.taxRates || []).reduce((a: number, t: any) => a + (t.taxAmount || 0), 0)
  );
}

// ── cargos (fee / shipping): se facturan por VALOR, no por conteo ────────────
//
// El delta de ítems compara CANTIDADES (`lineKey` excluye el precio a propósito, ver
// arriba). Eso funciona para los ítems, que se agregan y se quitan. Pero un cargo no
// cambia de cantidad: cambia de VALOR — el fee de mantenimiento escala con el subtotal,
// así que sigue estando 1 vez en facturado y 1 vez en actual (delta 0) mientras su precio
// crece. Resultado: lo que el cargo creció no se factura nunca. Por eso los cargos salen
// del multiset y se reconcilian restando valores.

/**
 * Nombres de las líneas que son un CARGO, no un ítem. El edge mete `fee_lines` y
 * `shipping_lines` en el MISMO array que los ítems (`clover-helper.ts:1264-1265`), así que
 * en el payload congelado la única señal es el nombre.
 */
export function chargeLineNames(order: any): Set<string> {
  const names = new Set<string>();
  for (const l of [...((order?.fee_lines as any[]) || []), ...((order?.shipping_lines as any[]) || [])]) {
    const n = l?.name;
    if (typeof n === 'string' && n.trim()) names.add(n);
  }
  return names;
}

export function isChargeLine(li: any, names: Set<string>): boolean {
  return names.size > 0 && names.has(li?.name);
}

/** Σ `price` de las líneas de cargo. */
export function sumChargePrices(lines: any[], names: Set<string>): number {
  return (lines || []).reduce((a: number, li: any) => (isChargeLine(li, names) ? a + (li?.price || 0) : a), 0);
}

/**
 * UNA línea que factura lo que el cargo CRECIÓ respecto de lo ya facturado en Clover.
 *
 * El nombre queda IDÉNTICO al del cargo a propósito: el siguiente suplemento vuelve a sumar
 * los cargos ya facturados **por nombre**, y renombrarla rompería esa suma.
 *
 * El impuesto se reparte en proporción al precio en vez de recalcularse sobre la diferencia
 * (40 × 10.5 % daría 4, cuando lo que falta son 5). Es reparto de itemización: el monto que
 * se cobra lo fija el total de la orden, no la suma de estas líneas.
 */
export function buildChargeDeltaLine(
  frozenLineItems: any[],
  names: Set<string>,
  billedChargeCents: number
): any | null {
  const nowPrice = sumChargePrices(frozenLineItems, names);
  const delta = nowPrice - billedChargeCents;
  if (delta <= 0) return null;

  const template = (frozenLineItems || []).find((li) => isChargeLine(li, names));
  if (!template) return null;

  const share = nowPrice > 0 ? delta / nowPrice : 0;
  const taxRates = ((template.taxRates as any[]) || []).map((t: any) => ({
    ...t,
    taxAmount: Math.round((t.taxAmount || 0) * share),
  }));
  return { ...template, price: delta, ...(taxRates.length ? { taxRates } : {}) };
}

/**
 * Ajusta UNA línea para que `Σ(price + taxAmount) == targetCents`.
 *
 * Hace falta porque **Clover cobra la suma de las líneas, no `order.total`**. Verificado en
 * vivo: la orden `Y6095EKT4P4P2` guardaba `total = 3892` y el Flex cobró **3893**, que es lo
 * que sumaban sus líneas. `order.total` es registro; el tender sigue la itemización.
 *
 * Mismo principio que el absorber del primario (`clover-helper.ts:1340-1343`): se prefiere la
 * línea de cargo —que ya es un ajuste— y sólo si no sirve se toca la última línea de ítem.
 * Nunca deja una línea en 0 o negativo: Clover las rechaza.
 */
export function absorbToTarget(
  lines: any[],
  targetCents: number,
  chargeNames: Set<string>
): { lines: any[]; absorbedCents: number } {
  const sum = (ls: any[]) => ls.reduce((a, li) => a + lineTotalCents(li), 0);
  const delta = targetCents - sum(lines);
  if (delta === 0 || lines.length === 0) return { lines, absorbedCents: 0 };

  // Candidatas: primero los cargos (de atrás hacia adelante), después los ítems.
  const idxCargo: number[] = [];
  const idxItem: number[] = [];
  lines.forEach((li, i) => (isChargeLine(li, chargeNames) ? idxCargo : idxItem).unshift(i));

  for (const i of [...idxCargo, ...idxItem]) {
    const nuevo = (lines[i]?.price || 0) + delta;
    if (nuevo > 0) {
      const out = lines.slice();
      out[i] = { ...lines[i], price: nuevo };
      return { lines: out, absorbedCents: delta };
    }
  }
  return { lines, absorbedCents: 0 };
}

export interface SupplementTotal {
  totalCents: number;
  source: 'residual' | 'lines';
  residualCents: number | null;
}

/**
 * El total del suplemento es lo que REALMENTE falta por cobrar, no la suma de sus líneas:
 *
 *     residual = objetivo de la orden MCM − lo que Clover ya tiene facturado
 *
 * Es exacto por construcción y no depende de reconstruir impuestos: Clover guarda
 * literalmente el total que MCM le dicta (`reconcile-items.ts:189`, `helpers.ts:170`), así
 * que restar totales cierra al centavo con o sin cargo.
 *
 * Sin datos para calcularlo se cae a la suma de líneas — el comportamiento previo.
 */
export function resolveSupplementTotal(params: {
  orderTotalCents?: number | null;
  billedCloverTotalCents?: number | null;
  linesTotalCents: number;
}): SupplementTotal {
  const { orderTotalCents, billedCloverTotalCents, linesTotalCents } = params;
  const usable =
    typeof orderTotalCents === 'number' &&
    Number.isFinite(orderTotalCents) &&
    typeof billedCloverTotalCents === 'number' &&
    Number.isFinite(billedCloverTotalCents);
  if (!usable) return { totalCents: linesTotalCents, source: 'lines', residualCents: null };
  const residual = (orderTotalCents as number) - (billedCloverTotalCents as number);
  return { totalCents: residual, source: 'residual', residualCents: residual };
}

export function mergedBilledKeys(manifest: SupplementalManifest): Record<string, number> {
  const billed: Record<string, number> = { ...(manifest.primary?.billed_keys || {}) };
  for (const s of manifest.supplements || []) {
    for (const [k, c] of Object.entries(s.delta_keys || {})) {
      billed[k] = (billed[k] || 0) + c;
    }
  }
  return billed;
}

export function deltaSignature(deltaKeys: Record<string, number>): string {
  const sorted = Object.keys(deltaKeys)
    .sort()
    .map((k) => `${k}:${deltaKeys[k]}`)
    .join('|');
  return djb2(sorted);
}

export interface DeltaResult {
  hasRemoval: boolean;
  deltaLines: any[];
  deltaKeys: Record<string, number>;
  totalCents: number;
}

/**
 * Delta = current frozen line items MINUS what's already billed (multiset by
 * `lineKey`). Append-only is the common case. A net removal (a billed key whose
 * current count dropped) flags `hasRemoval` (deferred as a visible needs-review).
 */
export function computeDelta(currentLines: any[], billed: Record<string, number>): DeltaResult {
  const current = multisetFromLines(currentLines);

  let hasRemoval = false;
  for (const k of Object.keys(billed)) {
    if ((current[k] || 0) < billed[k]) {
      hasRemoval = true;
      break;
    }
  }

  const remaining: Record<string, number> = {};
  for (const k of Object.keys(current)) {
    const add = current[k] - (billed[k] || 0);
    if (add > 0) remaining[k] = add;
  }

  const deltaLines: any[] = [];
  const deltaKeys: Record<string, number> = {};
  for (const li of currentLines || []) {
    const k = lineKey(li);
    if (remaining[k] > 0) {
      deltaLines.push(li);
      remaining[k]--;
      deltaKeys[k] = (deltaKeys[k] || 0) + 1;
    }
  }

  const totalCents = deltaLines.reduce((a, li) => a + lineTotalCents(li), 0);
  return { hasRemoval, deltaLines, deltaKeys, totalCents };
}

// ── manifest persistence (read-modify-write, tenant-scoped) ──────────────────

export async function readManifest(siteId: number, orderId: unknown): Promise<SupplementalManifest> {
  const { data } = await supabase
    .from('orders')
    .select('additional_properties')
    .eq('id', orderId)
    .eq('site_id', siteId)
    .maybeSingle();
  const ap = (data?.additional_properties ?? {}) as Record<string, any>;
  return (ap.clover_supplemental ?? {}) as SupplementalManifest;
}

export async function writeManifest(
  siteId: number,
  orderId: unknown,
  manifest: SupplementalManifest
): Promise<void> {
  const { data } = await supabase
    .from('orders')
    .select('additional_properties')
    .eq('id', orderId)
    .eq('site_id', siteId)
    .maybeSingle();
  const ap = {
    ...((data?.additional_properties ?? {}) as Record<string, any>),
    clover_supplemental: manifest,
  };
  const { error } = await supabase
    .from('orders')
    .update({ additional_properties: ap })
    .eq('id', orderId)
    .eq('site_id', siteId);
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover supplemental: failed to write manifest');
  }
}

/**
 * Persist a supplement's Clover order id into its manifest entry (by
 * delta_signature) ATÓMICAMENTE (RPC `set_clover_supplement_clover_id` bajo
 * `FOR UPDATE`) — no read-modify-write en JS, así no se pierde frente a un append
 * concurrente de otro reconcile.
 */
export async function persistSupplementCloverId(
  siteId: number,
  orderId: unknown,
  deltaSig: string,
  cloverOrderId: string,
  totalCents?: number
): Promise<void> {
  const { error } = await supabase.rpc('set_clover_supplement_clover_id', {
    p_site_id: siteId,
    p_order_id: orderId,
    p_delta_signature: deltaSig,
    p_clover_order_id: cloverOrderId,
    p_total_cents: totalCents ?? null,
  });
  if (error) {
    logger.error(
      { error, site_id: siteId, order_id: orderId, delta_signature: deltaSig },
      'clover supplemental: failed to persist supplement clover id'
    );
  }
}

/**
 * Called by `reconcile_items` when the PRIMARY Clover order is already paid.
 * Replaces the old silent skip: computes the delta and, if there are new items,
 * enqueues a supplemental order job (visible in /admin/jobs). Returns a visible
 * result in every branch (never a silent loss).
 */
export async function handlePaidPrimaryDelta(params: {
  siteId: number;
  orderId: unknown;
  cloverOrderId: string;
  frozenLineItems: any[];
  desiredHash?: string;
  currentCloverLineItems: Array<{ name?: string; note?: string; price?: number }>;
  correlationId?: string;
  /** `order_total_cents` del payload congelado: el objetivo de dinero de la orden MCM. */
  orderTotalCents?: number | null;
  /** `total` que Clover guarda HOY en la orden primaria (lo dicta MCM, no lo calcula Clover). */
  primaryCloverTotalCents?: number | null;
  /**
   * Lee una orden de Clover (total + líneas). Sólo se usa cuando ya existen suplementos
   * previos que hay que descontar. Se inyecta para poder testear el cálculo sin red.
   */
  fetchCloverOrder?: (
    cloverOrderId: string
  ) => Promise<{ total?: number; lineItems?: Array<{ name?: string; price?: number }> } | null>;
}): Promise<Record<string, unknown>> {
  const { siteId, orderId, cloverOrderId, frozenLineItems, desiredHash, currentCloverLineItems } = params;

  // Bookkeeping del delta ATÓMICO (RPC `claim_clover_supplement` bajo FOR UPDATE):
  // computa delta = current − billed (primary + supplements YA creados) y appendea
  // la entrada. Dos reconcile concurrentes se serializan → reconcile-2 recomputa
  // contra el billed actualizado por reconcile-1 → sin solapamiento ni corrupción.
  const currentKeys = multisetFromLines(frozenLineItems);
  const seedBilled = multisetFromLines(currentCloverLineItems);

  const { data, error } = await supabase.rpc('claim_clover_supplement', {
    p_site_id: siteId,
    p_order_id: orderId,
    p_current_keys: currentKeys,
    p_seed_billed_keys: seedBilled,
    p_primary_clover_order_id: cloverOrderId,
  });

  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover supplemental: claim RPC failed');
    throw new HandlerError(
      `claim_clover_supplement failed: ${error.message}`,
      'CLOVER_SUPPLEMENT_CLAIM_FAILED',
      true
    );
  }

  const res = (data ?? {}) as {
    has_delta?: boolean;
    has_removal?: boolean;
    delta_keys?: Record<string, number>;
    delta_signature?: string;
    external_reference_id?: string;
  };

  // Remoción post-pago (delta negativo) → refund sobre orden bloqueada → VISIBLE, diferido.
  if (res.has_removal && !res.has_delta) {
    await persistInjectionError(siteId, orderId, {
      code: 'CLOVER_SUPPLEMENTAL_NEGATIVE_DELTA',
      message:
        'Items were removed after the Clover order was paid; a negative supplement cannot be billed (needs a refund).',
    });
    if (desiredHash) await persistCloverHash(siteId, orderId, desiredHash);
    return { needs_review: 'negative_delta' };
  }

  // Sin ítems nuevos → nada que facturar; persistir el hash del primario.
  if (!res.has_delta) {
    if (desiredHash) await persistCloverHash(siteId, orderId, desiredHash);
    return { skipped: 'no_delta_paid' };
  }

  // Construir los line_items del suplemento desde los delta_keys que devolvió la
  // RPC (subconjunto del array congelado, respetando counts) + total.
  const deltaKeys = res.delta_keys ?? {};
  const remaining: Record<string, number> = { ...deltaKeys };
  const rawDeltaLines: any[] = [];
  for (const li of frozenLineItems) {
    const k = lineKey(li);
    if (remaining[k] > 0) {
      rawDeltaLines.push(li);
      remaining[k]--;
    }
  }

  // Nombre visible del suplemento en el Register: la misma mesa que la orden primaria,
  // marcada como adicional, para que el cajero vea a qué cheque pertenece. Espejo de
  // `buildCloverOrderTitle` del edge (`_shared/helpers/clover-helper.ts`); se duplica
  // porque los dos repos no comparten código. `fee_lines`/`shipping_lines` vienen en el
  // mismo select porque son las que identifican qué línea es un cargo.
  const { data: ord } = await supabase
    .from('orders')
    .select('table, experience, experience_reference, customer, fee_lines, shipping_lines')
    .eq('id', orderId)
    .eq('site_id', siteId)
    .maybeSingle();

  // ── cargos: fuera del multiset, reconciliados por valor ───────────────────
  // El filtro se aplica a las líneas que SALEN, no a las que ENTRAN a la RPC: `currentKeys`
  // y `seedBilled` quedan idénticos a antes, así que no hay `has_removal` falso ni cambio
  // en el bookkeeping de llaves ya persistido.
  const chargeNames = chargeLineNames(ord);
  const deltaLines = rawDeltaLines.filter((li) => !isChargeLine(li, chargeNames));

  // Lo que Clover ya tiene facturado: la primaria + los suplementos previos que YA existen
  // (el recién appendeado por la RPC todavía no tiene `clover_order_id`).
  let billedChargeCents = sumChargePrices(currentCloverLineItems, chargeNames);
  let billedTotalCents =
    typeof params.primaryCloverTotalCents === 'number' ? params.primaryCloverTotalCents : null;

  const priorSupplements = ((await readManifest(siteId, orderId)).supplements || []).filter(
    (s) => s.clover_order_id && s.delta_signature !== res.delta_signature
  );
  if (priorSupplements.length > 0) {
    if (!params.fetchCloverOrder) {
      // Sin poder leer los suplementos previos no se puede saber cuánto falta. Antes que
      // facturar un número inventado, reintentar.
      throw new HandlerError(
        'clover supplemental: cannot read prior supplements to compute the residual',
        'CLOVER_SUPPLEMENT_RESIDUAL_UNAVAILABLE',
        true
      );
    }
    for (const s of priorSupplements) {
      const prev = await params.fetchCloverOrder(s.clover_order_id as string);
      if (!prev || typeof prev.total !== 'number') {
        throw new HandlerError(
          `clover supplemental: could not read prior supplement ${s.clover_order_id}`,
          'CLOVER_SUPPLEMENT_RESIDUAL_UNAVAILABLE',
          true
        );
      }
      if (billedTotalCents !== null) billedTotalCents += prev.total;
      billedChargeCents += sumChargePrices(prev.lineItems || [], chargeNames);
    }
  }

  const chargeDeltaLine = buildChargeDeltaLine(frozenLineItems, chargeNames, billedChargeCents);
  if (chargeDeltaLine) deltaLines.push(chargeDeltaLine);

  if (deltaLines.length === 0) {
    if (desiredHash) await persistCloverHash(siteId, orderId, desiredHash);
    return { skipped: 'no_billable_delta' };
  }

  const linesTotalCents = deltaLines.reduce((a, li) => a + lineTotalCents(li), 0);
  const resolved = resolveSupplementTotal({
    orderTotalCents: params.orderTotalCents,
    billedCloverTotalCents: billedTotalCents,
    linesTotalCents,
  });

  // Techo duro: nunca se factura más de lo que falta. Si no falta nada (o Clover ya tiene de
  // más), se hace VISIBLE en vez de cobrar — esto es lo que hace imposible el doble cobro
  // aunque el manifiesto se pierda.
  if (resolved.source === 'residual' && resolved.totalCents <= 0) {
    await persistInjectionError(siteId, orderId, {
      code: 'CLOVER_SUPPLEMENTAL_NO_RESIDUAL',
      message: `Clover already bills ${billedTotalCents} of an order worth ${params.orderTotalCents}; nothing left to charge on a supplement.`,
    });
    if (desiredHash) await persistCloverHash(siteId, orderId, desiredHash);
    return { needs_review: 'no_residual', residual_cents: resolved.totalCents };
  }

  const totalCents = resolved.totalCents;

  // Clover COBRA la suma de las líneas, no `order.total`. Si la itemización no da exactamente
  // el residual, el Flex cobraría de más o de menos aunque el total dijera lo correcto — pasó
  // en vivo (orden 10345: total 3892, líneas 3893, cobrado 3893 → paid 64.88 vs total 64.87).
  // Se cuadra la itemización contra el residual antes de encolar.
  let billableLines = deltaLines;
  if (resolved.source === 'residual' && totalCents !== linesTotalCents) {
    const absorbed = absorbToTarget(deltaLines, totalCents, chargeNames);
    billableLines = absorbed.lines;
    const finalTotal = billableLines.reduce((a, li) => a + lineTotalCents(li), 0);
    logger.info(
      {
        site_id: siteId,
        order_id: orderId,
        residual_cents: totalCents,
        lines_total_cents: linesTotalCents,
        absorbed_cents: absorbed.absorbedCents,
        final_lines_total: finalTotal,
      },
      'clover supplemental: itemization reconciled to the residual'
    );
    if (finalTotal !== totalCents) {
      // No hubo dónde absorber sin dejar una línea en 0 o negativo. Se hace visible antes que
      // cobrar un número que no cuadra.
      await persistInjectionError(siteId, orderId, {
        code: 'CLOVER_SUPPLEMENTAL_UNRECONCILED',
        message: `Supplement line items total ${finalTotal} but ${totalCents} is owed; could not absorb the ${totalCents - finalTotal} cent difference.`,
      });
    }
  }
  // MIRROR de `buildCloverOrderTitle` / `ETIQUETA_EXPERIENCIA` del edge
  // (`_shared/helpers/clover-helper.ts`). Ojo con el `??` que había aquí: `table` viene
  // con cadenas VACÍAS en las órdenes que no son de mesa, y `"" ?? x` devuelve `""`,
  // así que el número de habitación nunca llegaba al POS.
  const ETIQUETA_EXPERIENCIA: Record<string, string> = {
    room: 'Room',
    lobby: 'Lobby',
    bc: 'Beach Club',
  };
  const cliente = [(ord as any)?.customer?.first_name, (ord as any)?.customer?.last_name]
    .filter(Boolean).join(' ').trim();
  const etiquetaMesa = String((ord as any)?.table?.label ?? '').trim();
  const referencia = String((ord as any)?.experience_reference ?? '').trim();
  let nombre: string;
  if (etiquetaMesa) {
    nombre = etiquetaMesa;
  } else if (referencia) {
    const etiqueta = ETIQUETA_EXPERIENCIA[String((ord as any)?.experience ?? '').toLowerCase()];
    nombre = etiqueta ? `${etiqueta} ${referencia}` : referencia;
  } else {
    nombre = cliente;
  }
  // El id va siempre: la etiqueta sola no distingue una orden de otra (mesas que se repiten,
  // multi-check sobre la misma mesa). Mismo formato que el primario, + la marca de adicional.
  const etiqueta = nombre ? `${nombre} · #${orderId}` : `MCM #${orderId}`;

  const jobId = await enqueueCloverSupplementalInjection({
    siteId,
    orderId: orderId as string | number,
    externalReferenceId: res.external_reference_id!,
    deltaSignature: res.delta_signature!,
    lineItems: billableLines,
    totalCents,
    correlationId: params.correlationId,
    title: `${etiqueta} (add'l)`,
  });

  // Persist the primary hash so the recurring primary push stops re-triggering —
  // the new items now live on the supplement.
  if (desiredHash) await persistCloverHash(siteId, orderId, desiredHash);

  logger.info(
    { site_id: siteId, order_id: orderId, supplemental_job: jobId, delta_items: deltaLines.length },
    'clover reconcile: primary paid → enqueued supplemental order (atomic delta)'
  );
  return { supplemental_enqueued: jobId, delta_items: deltaLines.length };
}
