import { AxiosInstance } from 'axios';
import { supabase } from '../../../lib/supabase';
import { readAllBySite } from '../../omnivore/sync/inventory/supabase-read';
import { aplicarOverridesLocales, CAMPOS_PROTEGIDOS } from './local-overrides';
import { fetchAllCloverElements, insertOrAdopt, archiveIsSafe } from './catalog-sync';
import { logger } from '../../../lib/logger';

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
  productCloverToMcm: Map<string, number>,
  preservarEdiciones = false
): Promise<ModStats> {
  const stats: ModStats = { ingredients: { created: 0, updated: 0, skipped: 0, archived: 0 }, groups: { created: 0, updated: 0, skipped: 0, archived: 0 } };

  // Cursor, no offset (mismo motivo que `/categories`). Verificado contra el merchant que
  // `orderBy=id` + `filter=id>` funcionan Y que `expand=modifiers` se sigue respetando.
  const { elements: groups, complete } = await fetchAllCloverElements(
    client, siteId, '/modifier_groups', 'modifiers', { cursorField: 'id' });
  // Un grupo/modificador con `deleted:true` NO cuenta como presente: así cae en la rama de
  // archive en vez de re-crearse `published`. Es lo que `catalog-sync` ya hacía para items y
  // categorías y aquí faltaba. Campos verificados contra el merchant: el grupo trae `deleted`,
  // y el modificador trae `deleted` y `available`.
  const vivos = groups.filter((g: any) => g?.deleted !== true);
  const modsVivos = (g: any) => (g.modifiers?.elements ?? []).filter((m: any) => m?.deleted !== true);
  const presentGroupIds = new Set<string>(vivos.map((g: any) => String(g.id)));
  const presentModifierIds = new Set<string>();
  for (const g of vivos) for (const m of modsVivos(g)) presentModifierIds.add(String(m.id));

  // group cloverId -> set of MCM product id strings (from items' modifierGroups links)
  const groupToProducts = new Map<string, Set<string>>();
  for (const item of items) {
    const mcmId = productCloverToMcm.get(String(item.id));
    if (mcmId == null) continue;
    for (const g of item.modifierGroups?.elements ?? []) {
      const key = String(g.id);
      if (!presentGroupIds.has(key)) continue;   // grupo borrado en Clover: no re-enganchar
      if (!groupToProducts.has(key)) groupToProducts.set(key, new Set());
      groupToProducts.get(key)!.add(String(mcmId));
    }
  }

  // ── ingredients (modifier options) ──
  const exIng = await readAllBySite<any>('ingredients', siteId, 'id, name, price, additional_properties');
  const ingByClover = new Map<string, any>();
  for (const r of exIng ?? []) { const cid = parseAP((r as any).additional_properties).cloverId; if (cid) ingByClover.set(String(cid), r); }

  const modifierCloverToMcm = new Map<string, number>();
  for (const g of vivos) {
    for (const m of modsVivos(g)) {
      const mName = m.name ?? ''; // normalize null/empty → '' (else name comparison flaps forever)
      const price = (Number(m.price ?? 0) / 100).toFixed(2);
      // `available` se ignoraba y `stock_status` se escribía SIEMPRE 'instock': un modificador
      // 86'eado en el terminal seguía ofreciéndose en MCM. Es el equivalente del 86 de producto.
      const modStock = m?.available === false ? 'outofstock' : 'instock';
      const prev = ingByClover.get(String(m.id));
      if (prev) {
        modifierCloverToMcm.set(String(m.id), Number(prev.id));
        // RESURRECT: a reappeared, previously-archived modifier must be un-archived (else it stays hidden).
        const wasArchived = parseAP(prev.additional_properties).cloverArchived === true;
        const apIng: Record<string, any> = { ...parseAP(prev.additional_properties), cloverId: String(m.id), cloverName: mName, cloverArchived: false };
        const baselinePrevia = JSON.stringify(apIng.cloverBaseline ?? null);
        const overridesPreviasIng = JSON.stringify(apIng.cloverOverrides ?? null);
        const { base: nomFinal } = aplicarOverridesLocales(
          CAMPOS_PROTEGIDOS.ingredients, prev, { name: mName }, apIng, preservarEdiciones);
        const changed = (prev.name ?? '') !== nomFinal.name
          || Math.round(Number(prev.price) * 100) !== Math.round(Number(price) * 100)
          || (prev.stock_status ?? 'instock') !== modStock
          || baselinePrevia !== JSON.stringify(apIng.cloverBaseline ?? null)
          // ...y la propia MARCA de override: en régimen estacionario nada más difiere (MCM ya
          // tiene su valor y Clover no ha cambiado) ⇒ `changed` falso ⇒ la marca no se escribiría
          // nunca, y sin ella tampoco se podría liberar el override después.
          || overridesPreviasIng !== JSON.stringify(apIng.cloverOverrides ?? null)
          || wasArchived;
        if (!changed) { stats.ingredients.skipped++; continue; }
        const { error } = await supabase.from('ingredients')
          .update({ name: nomFinal.name, price, stock_status: modStock, additional_properties: apIng, date_updated: new Date().toISOString() })
          .eq('id', prev.id).eq('site_id', siteId);
        if (error) throw error;
        stats.ingredients.updated++;
      } else {
        const { id, adopted } = await insertOrAdopt('ingredients', siteId, String(m.id),
          { site_id: siteId, name: mName, description: '', price, measurement_type: 'unit', stock_status: modStock, additional_properties: { cloverId: String(m.id), cloverName: mName }, variations: [], translations: {} });
        modifierCloverToMcm.set(String(m.id), id);
        ingByClover.set(String(m.id), { id, name: mName, price, stock_status: modStock, additional_properties: { cloverId: String(m.id) } });
        if (adopted) stats.ingredients.updated++; else stats.ingredients.created++;
      }
    }
  }

  // ── ingredients_groups (modifier groups) ──
  const exGrp = await readAllBySite<any>(
    'ingredients_groups', siteId,
    'id, name, label, minimum, maximum, ingredients, products_included, additional_properties');
  const grpByClover = new Map<string, any>();
  for (const r of exGrp ?? []) { const cid = parseAP((r as any).additional_properties).cloverId; if (cid) grpByClover.set(String(cid), r); }

  // order-insensitive comparison of the ingredient-ref array (Clover may reorder modifiers).
  const refKey = (arr: any) => JSON.stringify([...(arr ?? [])].map((x: any) => Number(x?.id)).filter((n: number) => !isNaN(n)).sort((a: number, b: number) => a - b));

  for (const g of vivos) {
    const gName = g.name ?? '';
    const ingredientRefs = modsVivos(g)
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
      const baselineGrupo = JSON.stringify((ap as any).cloverBaseline ?? null);
      const overridesPreviasGrp = JSON.stringify((ap as any).cloverOverrides ?? null);
      const { base: grpFinal } = aplicarOverridesLocales(
        CAMPOS_PROTEGIDOS.ingredients_groups, prev, { name: gName, label: gName },
        ap as Record<string, any>, preservarEdiciones);
      const changed =
        (prev.name ?? '') !== grpFinal.name || (prev.label ?? '') !== grpFinal.label ||
        refKey(prev.ingredients) !== refKey(ingredientRefs) ||
        JSON.stringify([...(prev.products_included ?? [])].map(String).sort()) !== JSON.stringify([...productsIncluded].sort()) ||
        Number(prev.minimum ?? 0) !== minimum || (prev.maximum ?? null) !== maximum ||
        baselineGrupo !== JSON.stringify((ap as any).cloverBaseline ?? null) || wasArchived ||
        // ...y la propia MARCA de override: en régimen estacionario nada más difiere (MCM ya
        // tiene su valor y Clover no ha cambiado) ⇒ `changed` falso ⇒ la marca no se escribiría
        // nunca, y sin ella tampoco se podría liberar el override después.
        overridesPreviasGrp !== JSON.stringify((ap as any).cloverOverrides ?? null);
      if (!changed) { stats.groups.skipped++; continue; }
      const { error } = await supabase.from('ingredients_groups')
        .update({ name: grpFinal.name, label: grpFinal.label, minimum, maximum, ingredients: ingredientRefs, products_included: productsIncluded, status: 'published', additional_properties: ap, date_updated: new Date().toISOString() })
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
  if (!archiveIsSafe(complete, presentGroupIds.size, grpByClover.size)) {
    // Sin esto el guard bloqueaba en SILENCIO — productos y categorías sí lo loguean.
    logger.warn({ site_id: siteId, present: presentGroupIds.size, existing: grpByClover.size, complete },
      'clover_archive_skipped_suspicious_modifier_groups');
  }
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
  if (!archiveIsSafe(complete, presentModifierIds.size, ingByClover.size)) {
    logger.warn({ site_id: siteId, present: presentModifierIds.size, existing: ingByClover.size, complete },
      'clover_archive_skipped_suspicious_modifiers');
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
