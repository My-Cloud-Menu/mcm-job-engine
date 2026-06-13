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
 *  - MCM-UNFIRED  (status 'new', sin id)            → intacto (nunca se anula por ausencia).
 *  - POS-ADD      (id solo en el ticket)            → adopción por firma contra 'sent' sin id,
 *                                                     si no, append como línea nueva.
 */

interface AnyItem {
  id: string;
  product_id?: unknown;
  quantity?: unknown;
  notes?: unknown;
  status?: string;
  additional_properties?: any;
  [k: string]: unknown;
}

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

export function mergeManagedOrderLineItems(
  existingInput: AnyItem[] | undefined,
  mappedInput: AnyItem[] | undefined,
): AnyItem[] {
  const existing = Array.isArray(existingInput) ? existingInput : [];
  const mapped = Array.isArray(mappedInput) ? mappedInput : [];

  const mappedByOmniId = new Map<string, AnyItem>();
  for (const m of mapped) {
    const id = omniId(m);
    if (id) mappedByOmniId.set(id, m);
  }

  // Candidatos a adopción por firma: existentes 'sent' SIN ningún omnivore.item_id
  // (ventana de crash: Omnivore agregó el ítem pero MCM no guardó el id).
  const adoptable = existing.filter((e) => e.status === 'sent' && omniIdsOf(e).length === 0);
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

  // 2) MAPPED no correlacionados → adopción por firma o POS-add.
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
    if (candidate && id) {
      adoptedExistingIds.add(candidate.id);
      const idx = result.findIndex((r) => r.id === candidate.id);
      if (idx >= 0) {
        result[idx] = {
          ...result[idx],
          additional_properties: {
            ...(result[idx].additional_properties ?? {}),
            omnivore: {
              ...(result[idx].additional_properties?.omnivore ?? {}),
              item_id: id,
              origin: 'mcm',
              sent_to_pos: true,
            },
          },
        };
      }
      continue;
    }

    // POS-add: línea nueva (uuid fresco), preservando el stamp omnivore.origin='pos'.
    result.push({ ...m, id: randomUUID() });
  }

  return result;
}
