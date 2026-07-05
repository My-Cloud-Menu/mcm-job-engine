import { AxiosInstance } from 'axios';
import { supabase } from '../../../lib/supabase';
import { fetchAllCloverElements, insertOrAdopt, archiveIsSafe } from './catalog-sync';

/**
 * Clover → MCM MODIFIER catalog sync (ADDITIVE). Clover modifier_groups/modifiers → MCM
 * `ingredients_groups` / `ingredients`, matched by `additional_properties.cloverId` (mirrors
 * omnivoreId). Shape learned from real Omnivore-synced rows:
 *   - ingredient  = { site_id, name, price(numeric), additional_properties:{cloverId,cloverName} }
 *   - group.ingredients jsonb = [{ id: <mcm ingredient id> }, ...]
 *   - group.products_included  = text[] of MCM product ids (as strings)
 * Idempotent (price compared in integer cents). Create/update only (archive of modifiers is a
 * documented follow-up — lower risk than product archive). Every read/write scoped by site_id.
 */

interface ModStats { ingredients: { created: number; updated: number; skipped: number; archived: number }; groups: { created: number; updated: number; skipped: number; archived: number } }
const parseAP = (v: any): Record<string, any> => (v == null ? {} : typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : v);

export async function syncCloverModifiers(
  siteId: number,
  client: AxiosInstance,
  items: any[],
  productCloverToMcm: Map<string, number>
): Promise<ModStats> {
  const stats: ModStats = { ingredients: { created: 0, updated: 0, skipped: 0, archived: 0 }, groups: { created: 0, updated: 0, skipped: 0, archived: 0 } };

  const { elements: groups, complete } = await fetchAllCloverElements(client, siteId, '/modifier_groups', 'modifiers');
  const presentGroupIds = new Set<string>(groups.map((g: any) => String(g.id)));
  const presentModifierIds = new Set<string>();
  for (const g of groups) for (const m of g.modifiers?.elements ?? []) presentModifierIds.add(String(m.id));

  // group cloverId -> set of MCM product id strings (from items' modifierGroups links)
  const groupToProducts = new Map<string, Set<string>>();
  for (const item of items) {
    const mcmId = productCloverToMcm.get(String(item.id));
    if (mcmId == null) continue;
    for (const g of item.modifierGroups?.elements ?? []) {
      const key = String(g.id);
      if (!groupToProducts.has(key)) groupToProducts.set(key, new Set());
      groupToProducts.get(key)!.add(String(mcmId));
    }
  }

  // ── ingredients (modifier options) ──
  const { data: exIng, error: e1 } = await supabase
    .from('ingredients').select('id, name, price, additional_properties').eq('site_id', siteId);
  if (e1) throw e1;
  const ingByClover = new Map<string, any>();
  for (const r of exIng ?? []) { const cid = parseAP((r as any).additional_properties).cloverId; if (cid) ingByClover.set(String(cid), r); }

  const modifierCloverToMcm = new Map<string, number>();
  for (const g of groups) {
    for (const m of g.modifiers?.elements ?? []) {
      const mName = m.name ?? ''; // normalize null/empty → '' (else name comparison flaps forever)
      const price = (Number(m.price ?? 0) / 100).toFixed(2);
      const prev = ingByClover.get(String(m.id));
      if (prev) {
        modifierCloverToMcm.set(String(m.id), Number(prev.id));
        // RESURRECT: a reappeared, previously-archived modifier must be un-archived (else it stays hidden).
        const wasArchived = parseAP(prev.additional_properties).cloverArchived === true;
        const changed = (prev.name ?? '') !== mName || Math.round(Number(prev.price) * 100) !== Math.round(Number(price) * 100) || wasArchived;
        if (!changed) { stats.ingredients.skipped++; continue; }
        const { error } = await supabase.from('ingredients')
          .update({ name: mName, price, stock_status: 'instock', additional_properties: { ...parseAP(prev.additional_properties), cloverId: String(m.id), cloverName: mName, cloverArchived: false }, date_updated: new Date().toISOString() })
          .eq('id', prev.id).eq('site_id', siteId);
        if (error) throw error;
        stats.ingredients.updated++;
      } else {
        const { id, adopted } = await insertOrAdopt('ingredients', siteId, String(m.id),
          { site_id: siteId, name: mName, description: '', price, measurement_type: 'unit', stock_status: 'instock', additional_properties: { cloverId: String(m.id), cloverName: mName }, variations: [], translations: {} });
        modifierCloverToMcm.set(String(m.id), id);
        ingByClover.set(String(m.id), { id, name: mName, price, additional_properties: { cloverId: String(m.id) } });
        if (adopted) stats.ingredients.updated++; else stats.ingredients.created++;
      }
    }
  }

  // ── ingredients_groups (modifier groups) ──
  const { data: exGrp, error: e2 } = await supabase
    .from('ingredients_groups').select('id, name, label, minimum, maximum, ingredients, products_included, additional_properties').eq('site_id', siteId);
  if (e2) throw e2;
  const grpByClover = new Map<string, any>();
  for (const r of exGrp ?? []) { const cid = parseAP((r as any).additional_properties).cloverId; if (cid) grpByClover.set(String(cid), r); }

  // order-insensitive comparison of the ingredient-ref array (Clover may reorder modifiers).
  const refKey = (arr: any) => JSON.stringify([...(arr ?? [])].map((x: any) => Number(x?.id)).filter((n: number) => !isNaN(n)).sort((a: number, b: number) => a - b));

  for (const g of groups) {
    const gName = g.name ?? '';
    const ingredientRefs = (g.modifiers?.elements ?? [])
      .map((m: any) => modifierCloverToMcm.get(String(m.id)))
      .filter((x: any) => x != null)
      .map((id: number) => ({ id }));
    const productsIncluded = Array.from(groupToProducts.get(String(g.id)) ?? []);
    const minimum = Number(g.minRequired ?? 0);
    // Clover maxAllowed=0 means UNLIMITED → store null (MCM null = no cap; 0 could be read as "0 allowed").
    const maximum = g.maxAllowed != null && Number(g.maxAllowed) > 0 ? Number(g.maxAllowed) : null;
    const prev = grpByClover.get(String(g.id));
    const ap = { ...(prev ? parseAP(prev.additional_properties) : {}), cloverId: String(g.id), cloverName: gName, cloverArchived: false };

    if (prev) {
      // RESURRECT: a reappeared, previously-archived group must be un-archived (status back to published).
      const wasArchived = parseAP(prev.additional_properties).cloverArchived === true;
      const changed =
        (prev.name ?? '') !== gName ||
        refKey(prev.ingredients) !== refKey(ingredientRefs) ||
        JSON.stringify([...(prev.products_included ?? [])].map(String).sort()) !== JSON.stringify([...productsIncluded].sort()) ||
        Number(prev.minimum ?? 0) !== minimum || (prev.maximum ?? null) !== maximum || wasArchived;
      if (!changed) { stats.groups.skipped++; continue; }
      const { error } = await supabase.from('ingredients_groups')
        .update({ name: gName, label: gName, minimum, maximum, ingredients: ingredientRefs, products_included: productsIncluded, status: 'published', additional_properties: ap, date_updated: new Date().toISOString() })
        .eq('id', prev.id).eq('site_id', siteId);
      if (error) throw error;
      stats.groups.updated++;
    } else {
      const { adopted } = await insertOrAdopt('ingredients_groups', siteId, String(g.id),
        { site_id: siteId, name: gName, label: gName, minimum, maximum, maxoccurrencesperitem: 20, ingredients: ingredientRefs, ingredients_included: [], products_included: productsIncluded, categories_included: [], additional_properties: ap, status: 'published', tags: [], translations: {} });
      if (adopted) stats.groups.updated++; else stats.groups.created++;
    }
  }

  // Soft-archive (G9, same floor-guard as products/categories): ingredients_groups / ingredients
  // whose cloverId disappeared from a COMPLETE, non-degraded Clover fetch.
  if (archiveIsSafe(complete, presentGroupIds.size, grpByClover.size)) {
    for (const [cid, row] of grpByClover) {
      if (presentGroupIds.has(cid)) continue;
      const ap = parseAP(row.additional_properties);
      if (ap.cloverArchived === true) continue;
      const { error } = await supabase.from('ingredients_groups')
        .update({ status: 'draft', additional_properties: { ...ap, cloverArchived: true }, date_updated: new Date().toISOString() })
        .eq('id', row.id).eq('site_id', siteId);
      if (error) throw error;
      stats.groups.archived++;
    }
  }
  if (archiveIsSafe(complete, presentModifierIds.size, ingByClover.size)) {
    for (const [cid, row] of ingByClover) {
      if (presentModifierIds.has(cid)) continue;
      const ap = parseAP(row.additional_properties);
      if (ap.cloverArchived === true) continue;
      const { error } = await supabase.from('ingredients')
        .update({ stock_status: 'outofstock', additional_properties: { ...ap, cloverArchived: true }, date_updated: new Date().toISOString() })
        .eq('id', row.id).eq('site_id', siteId);
      if (error) throw error;
      stats.ingredients.archived++;
    }
  }

  return stats;
}
