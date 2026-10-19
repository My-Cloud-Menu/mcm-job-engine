import { supabase } from '../../../../lib/supabase';

/**
 * C3 (Misión Omnivore Multisucursal) · Agotados de Aloha por sucursal en `stock_availability`.
 *
 * Cada fila que escribe el sync lleva `reason = OMNIVORE_OOS_REASON` y la sucursal (`location_id`). Reglas:
 * - Solo se escriben diferencias: se crea lo que Aloha marca agotado y no tiene fila, y se borra lo que el sync había
 *   marcado y Aloha ya no tiene agotado.
 * - Nunca se toca una fila de otro origen (un 86 manual, «no se vende en esta sucursal», etc.): si ya existe una fila con
 *   el mismo alcance, el sync no crea la suya ni la cambia.
 * - Las filas por sucursal no cambian `products.stock_status` del negocio (`stock_project_status` solo mira las filas sin
 *   sucursal).
 */
export const OMNIVORE_OOS_REASON = 'omnivore_oos';
const OOS_NOTE = 'Agotado en el POS (Aloha)';
const CHUNK = 500;

export type StockEntityType = 'product' | 'ingredient';

export interface StockRow {
  id: number | string;
  entity_type: string;
  entity_id: number | string | null;
  variation_id: string | null;
  channel_code: string | null;
  catalog_id: string | null;
  reason: string | null;
}

export interface LocationStockDiff {
  insert: Array<{ entity_type: StockEntityType; entity_id: number }>;
  deleteIds: Array<number | string>;
}

const keyOf = (type: string, id: unknown) => `${type}:${String(id)}`;

/** PURA. `desired` = claves `tipo:id` que Aloha tiene agotadas en esta sucursal. */
export function diffLocationStock(existing: StockRow[], desired: Map<string, { entity_type: StockEntityType; entity_id: number }>): LocationStockDiff {
  const plain = existing.filter((r) => r.variation_id == null && r.channel_code == null && r.catalog_id == null);
  const anyScope = new Set(plain.map((r) => keyOf(r.entity_type, r.entity_id)));
  const ours = plain.filter((r) => r.reason === OMNIVORE_OOS_REASON);
  return {
    insert: [...desired.entries()].filter(([k]) => !anyScope.has(k)).map(([, v]) => v),
    deleteIds: ours.filter((r) => !desired.has(keyOf(r.entity_type, r.entity_id))).map((r) => r.id),
  };
}

/** Mapa omnivoreId → id de MCM (productos o modificadores) del negocio. PURA. */
export function omnivoreIdMap(rows: Array<{ id: number | string; additional_properties?: Record<string, unknown> | null }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const oid = r.additional_properties?.['omnivoreId'];
    if (oid != null && oid !== '') out.set(String(oid), Number(r.id));
  }
  return out;
}

/** Arma las claves deseadas desde los agotados de Aloha. PURA. */
export function desiredOutOfStock(
  oosItems: Array<{ id: unknown }>,
  oosModifiers: Array<{ id: unknown }>,
  productIds: Map<string, number>,
  ingredientIds: Map<string, number>
): { desired: Map<string, { entity_type: StockEntityType; entity_id: number }>; unmapped: number } {
  const desired = new Map<string, { entity_type: StockEntityType; entity_id: number }>();
  let unmapped = 0;
  const add = (type: StockEntityType, list: Array<{ id: unknown }>, ids: Map<string, number>) => {
    for (const o of list) {
      const id = ids.get(String(o.id));
      if (id == null) { unmapped++; continue; }
      desired.set(keyOf(type, id), { entity_type: type, entity_id: id });
    }
  };
  add('product', oosItems, productIds);
  add('ingredient', oosModifiers, ingredientIds);
  return { desired, unmapped };
}

async function readLocationStock(siteId: number, locationId: number): Promise<StockRow[]> {
  const PAGE = 1000;
  const all: StockRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('stock_availability')
      .select('id, entity_type, entity_id, variation_id, channel_code, catalog_id, reason')
      .eq('site_id', siteId)
      .eq('location_id', locationId)
      .in('entity_type', ['product', 'ingredient'])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...((data ?? []) as StockRow[]));
    if ((data ?? []).length < PAGE) return all;
  }
}

/** Aplica la diferencia de UNA sucursal. Devuelve cuántas filas creó y borró. */
export async function applyLocationStock(
  siteId: number,
  locationId: number,
  desired: Map<string, { entity_type: StockEntityType; entity_id: number }>
): Promise<{ inserted: number; deleted: number }> {
  const diff = diffLocationStock(await readLocationStock(siteId, locationId), desired);

  for (let i = 0; i < diff.deleteIds.length; i += CHUNK) {
    const part = diff.deleteIds.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('stock_availability')
      .delete()
      .in('id', part)
      .eq('site_id', siteId)
      .eq('location_id', locationId)
      .eq('reason', OMNIVORE_OOS_REASON);
    if (error) throw error;
  }

  let inserted = 0;
  const rows = diff.insert.map((d) => ({
    site_id: siteId,
    location_id: locationId,
    entity_type: d.entity_type,
    entity_id: d.entity_id,
    status: 'out_of_stock',
    reason: OMNIVORE_OOS_REASON,
    notes: OOS_NOTE,
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from('stock_availability').insert(part);
    if (!error) { inserted += part.length; continue; }
    if ((error as { code?: string }).code !== '23505') throw error;
    // Alguien marcó el mismo alcance entre la lectura y la escritura (p. ej. un 86 manual): fila por fila, sin pisarlo.
    for (const row of part) {
      const { error: e1 } = await supabase.from('stock_availability').insert(row);
      if (!e1) inserted++;
      else if ((e1 as { code?: string }).code !== '23505') throw e1;
    }
  }
  return { inserted, deleted: diff.deleteIds.length };
}
