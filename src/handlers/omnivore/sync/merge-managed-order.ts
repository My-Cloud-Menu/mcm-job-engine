import { randomUUID } from 'crypto';

/**
 * Merge a nivel de ítem entre el carrito MCM (existente) y los ítems del ticket
 * Omnivore (mapeados), correlacionados por `additional_properties.omnivore.item_id`.
 * Puro y determinístico (salvo uuid/now). Reemplaza el overwrite de orden completa
 * para órdenes `omnivore_managed` (Fase 7 del plan de Order & Pay).
 *
 * 4 buckets:
 *  - MATCHED      (id en MCM y en el ticket)        → conserva la línea MCM (uuid/seat/notas).
 *  - TERMINAL-VOID(id en MCM activo, ausente)       → marca voided ("anulado en el terminal").
 *  - MCM-UNFIRED  (sin id, no 'sent')               → intacto (nunca se anula por ausencia).
 *  - POS-ADD      (id solo en el ticket)            → adopción contra líneas 'sent' sin id (por firma)
 *                                                     o con `fire_pending_at` reciente (por firma o por
 *                                                     producto+cantidad); si no, append como línea nueva.
 *
 * `fire_pending_at` (2026-09-18): lo escribe `send-to-kitchen` en la fase 0, ANTES de POSTear al POS.
 * Si el fire muere entre el POST y la estampa, la línea queda marcada y el ítem YA está en el ticket:
 * adoptarlo aquí evita el duplicado. Se exige el marcador explícito (y reciente) para no adoptar por
 * error un ítem tecleado en el terminal sobre una línea que el POS rechazó.
 */

interface AnyItem {
  id: string;
  product_id?: unknown;
  quantity?: unknown;
  notes?: unknown;
  status?: string | null;
  sent_at?: unknown;
  additional_properties?: any;
  [k: string]: unknown;
}

/** Un `fire_pending_at` más viejo que esto ya no justifica adoptar (el fire falló y nadie limpió). */
const FIRE_PENDING_ADOPT_MAX_MS = 10 * 60_000;

// item_id (singular) de un ítem mapeado de Omnivore (siempre 1 por fila del ticket).
const omniId = (it: AnyItem | undefined): string | undefined =>
  it?.additional_properties?.omnivore?.item_id;

// TODOS los omnivore item_id de una línea MCM: `item_ids[]` (cuando el POS expandió qty=N
// en N filas) + `item_id` singular (compat). Una línea MCM puede correlacionar con varias
// filas del ticket → evita duplicar al pull cuando Aloha parte una línea por cantidad.
const omniIdsOf = (it: AnyItem | undefined): string[] => {
  const o = it?.additional_properties?.omnivore;
  if (!o) return [];
  const ids: string[] = [];
  if (Array.isArray(o.item_ids)) for (const x of o.item_ids) if (x != null) ids.push(String(x));
  if (o.item_id != null) { const s = String(o.item_id); if (!ids.includes(s)) ids.push(s); }
  return ids;
};

const signature = (it: AnyItem): string =>
  `${String(it.product_id ?? '')}|${String(it.quantity ?? '')}|${String(it.notes ?? '')}`;

/** ¿Línea marcada por un fire reciente (fase 0) que no llegó a estampar? */
const isPendingFire = (it: AnyItem, nowMs: number): boolean => {
  const t = it?.additional_properties?.omnivore?.fire_pending_at;
  if (typeof t !== 'string') return false;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return false;
  return nowMs - ms <= FIRE_PENDING_ADOPT_MAX_MS; // un futuro (reloj adelantado) cuenta como reciente
};

/** Adopta en la línea MCM los ids del POS: pasa a 'sent', estampa origin 'mcm' y borra los marcadores. */
const adoptInto = (line: AnyItem, ids: string[], mapped: AnyItem): AnyItem => {
  const { fire_pending_at: _p, fire_id: _f, ...omni } = line.additional_properties?.omnivore ?? {};
  return {
    ...line,
    status: 'sent',
    ...(line.sent_at == null && mapped.sent_at != null ? { sent_at: mapped.sent_at } : {}),
    additional_properties: {
      ...(line.additional_properties ?? {}),
      omnivore: { ...omni, item_id: ids[0], item_ids: ids, origin: 'mcm', sent_to_pos: true },
    },
  };
};

export function mergeManagedOrderLineItems(
  existingInput: AnyItem[] | undefined,
  mappedInput: AnyItem[] | undefined,
): AnyItem[] {
  const existing = Array.isArray(existingInput) ? existingInput : [];
  const mapped = Array.isArray(mappedInput) ? mappedInput : [];
  const nowMs = Date.now();

  const mappedByOmniId = new Map<string, AnyItem>();
  for (const m of mapped) {
    const id = omniId(m);
    if (id) mappedByOmniId.set(id, m);
  }

  // Candidatos a adopción: existentes SIN ningún omnivore.item_id y no anulados, que estén
  // 'sent' (ventana de crash: Omnivore agregó el ítem pero MCM no guardó el id) o marcados por
  // un fire reciente (fase 0 de send-to-kitchen que murió antes de estampar).
  const adoptable = existing.filter(
    (e) => omniIdsOf(e).length === 0 && e.status !== 'voided' && (e.status === 'sent' || isPendingFire(e, nowMs)),
  );
  const adoptedExistingIds = new Set<string>();

  // Unión de TODOS los ids ya representados por líneas MCM existentes → para no re-appendear
  // una fila mapeada cuyo id ya pertenece a una línea (incl. las multi-id por qty-split).
  const existingIdSet = new Set<string>();
  for (const e of existing) for (const id of omniIdsOf(e)) existingIdSet.add(id);

  const result: AnyItem[] = [];

  // 1) EXISTENTES.
  for (const e of existing) {
    const ids = omniIdsOf(e);
    if (ids.length === 0) {
      // MCM-only (unfired / voided / 'sent' sin id pendiente de adopción) → intacto.
      result.push(e);
      continue;
    }
    // MATCHED si AL MENOS UNO de sus ids sigue en el ticket (una línea qty=N partida en N
    // filas sigue viva mientras quede una fila).
    const matchedMapped = ids.map((id) => mappedByOmniId.get(id)).find(Boolean);
    if (matchedMapped) {
      const mSent = matchedMapped.additional_properties?.omnivore?.sent;
      if (mSent && e.status !== 'voided' && e.status !== 'sent') {
        result.push({ ...e, status: 'sent' });
      } else {
        result.push(e);
      }
    } else {
      // TERMINAL-VOID: tenía id(s) pero NINGUNO está en el ticket → anulado en el terminal.
      if (e.status === 'voided') {
        result.push(e);
      } else {
        result.push({
          ...e,
          status: 'voided',
          void_reason: 'voided at terminal',
          voided_at: new Date().toISOString(),
        });
      }
    }
  }

  // 2) MAPPED no correlacionados → adopción por firma, luego por producto+cantidad (solo líneas
  //    con fire pendiente), y lo que quede como POS-add.
  const leftovers: AnyItem[] = [];
  for (const m of mapped) {
    const id = omniId(m);
    // Sin omnivore.item_id no hay ancla idempotente → NO appendear (evita re-append en
    // cada pull / crecimiento sin límite). Raro: FIELDS pide items(id,...). Skip + log.
    if (!id) {
      console.warn('[omnivore merge] mapped item without omnivore.item_id — skipped to avoid duplication');
      continue;
    }
    if (existingIdSet.has(String(id))) continue; // ya representado por una línea MCM (1)

    const sig = signature(m);
    const candidate = adoptable.find(
      (e) => !adoptedExistingIds.has(e.id) && signature(e) === sig,
    );
    if (candidate) {
      adoptedExistingIds.add(candidate.id);
      const idx = result.findIndex((r) => r.id === candidate.id);
      if (idx >= 0) result[idx] = adoptInto(result[idx], [id], m);
      continue;
    }
    leftovers.push(m);
  }

  // 2b) Líneas con fire pendiente: correlación por producto acumulando cantidad. Cubre lo que la
  //     firma no casa: Aloha parte qty=N en N filas qty=1, y el `comment` del POS no es igual a
  //     `notes` cuando MCM manda alergias/comentarios. Nunca sobre ítems `unmapped` (su product_id
  //     es el id de Omnivore) ni sobre líneas ya adoptadas.
  const remaining: AnyItem[] = [];
  const pendingLines = adoptable.filter((e) => !adoptedExistingIds.has(e.id) && isPendingFire(e, nowMs));
  let pool = leftovers.filter((m) => m?.additional_properties?.omnivore?.unmapped !== true);
  const unmappedLeftovers = leftovers.filter((m) => m?.additional_properties?.omnivore?.unmapped === true);
  for (const p of pendingLines) {
    const need = Number(p.quantity ?? 1) || 1;
    const pid = String(p.product_id ?? '');
    const take: AnyItem[] = [];
    let got = 0;
    for (const m of pool) {
      if (got >= need) break;
      if (String(m.product_id ?? '') !== pid) continue;
      take.push(m);
      got += Number(m.quantity ?? 1) || 1;
    }
    if (take.length === 0) continue;
    const ids = take.map((m) => String(omniId(m)));
    adoptedExistingIds.add(p.id);
    const idx = result.findIndex((r) => r.id === p.id);
    if (idx >= 0) result[idx] = adoptInto(result[idx], ids, take[0]);
    pool = pool.filter((m) => !take.includes(m));
  }
  remaining.push(...pool, ...unmappedLeftovers);

  // POS-add: línea nueva (uuid fresco), preservando el stamp omnivore.origin='pos'.
  for (const m of remaining) {
    result.push({ ...m, id: randomUUID() });
  }

  return result;
}
