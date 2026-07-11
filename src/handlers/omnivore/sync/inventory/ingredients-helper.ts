import Decimal from 'decimal.js';
import { AxiosInstance } from 'axios';
import type { OmnivoreIngredient, OmnivoreProduct, StockStatus } from './types';
import { fetchOmnivoreModifiers, fetchOmnivoreModifierGroups, fetchOmnivoreOosModifiers } from './menu-fetch';
import { readAllBySite } from './supabase-read';
import type { Changes } from './products-helper';
import type { SyncConflict } from './types';

// Ported from legacy ingredients-sync-helper.ts (Supabase path). isSupabase/ORM
// dropped, .limit() reads → full pagination, additional_properties merged on update.
// Modifier-group ref parse: a missing group is skipped+warned (not thrown) so one
// inconsistent reference can't fail the whole inventory sync.

const centsToDollars = (cents?: number) => new Decimal(cents || 0).div(100).toNumber();

/** Omnivore modifier group shape we build for MCM ingredients_groups. */
export interface OmnivoreGroupParsed {
  status: string;
  site_id: number;
  name: string;
  label: string;
  minimum: number;
  maximum: number;
  ingredients: Array<{ id: string }>;        // omnivore modifier ids (pre-map)
  products_included: string[];               // omnivore product ids (pre-map)
  ingredients_included: string[];            // omnivore ingredient ids (pre-map)
  additional_properties: { omnivoreId: string; omnivoreName: string };
}

function modifierGroupIdFromOptionSet(optionSet: any): string | null {
  const href: string | undefined = optionSet?._links?.modifier_group?.href;
  if (!href) return null;
  const parts = href.split('/');
  const i = parts.indexOf('modifier_groups');
  return i > -1 ? parts[i + 1] ?? null : null;
}

/** Modifiers (ingredients) with OOS merged, filtered to the referenced ids. */
export async function getOmnivoreIngredientsToImport(
  client: AxiosInstance,
  filterIds: string[]
): Promise<OmnivoreIngredient[]> {
  const [ingredients, oos] = await Promise.all([
    fetchOmnivoreModifiers(client),
    fetchOmnivoreOosModifiers(client),
  ]);
  oos.forEach((o) => {
    const idx = ingredients.findIndex((i) => i.id == o.id);
    if (idx > -1) ingredients[idx].in_stock = false;
  });
  const wanted = new Set(filterIds);
  return ingredients.filter((i) => wanted.has(i.id));
}

/**
 * Build the MCM modifier-group structures from Omnivore: one base group per Omnivore
 * modifier_group, then split/dedup by the (min,max) each product/ingredient uses, and
 * collect which products / ingredients reference each.
 */
export async function getOmnivoreIngredientGroupToImport(
  client: AxiosInstance,
  siteId: number,
  omnivoreProducts: OmnivoreProduct[]
): Promise<{ groups: OmnivoreGroupParsed[]; conflicts: SyncConflict[] }> {
  const parsed: OmnivoreGroupParsed[] = [];
  const conflicts: SyncConflict[] = [];
  const groups = await fetchOmnivoreModifierGroups(client);

  const semiParsed: OmnivoreGroupParsed[] = groups.map((g) => ({
    status: 'published',
    site_id: siteId,
    ingredients: (g._embedded?.modifiers || []).map((m: any) => ({ id: m.id })),
    name: g.name,
    label: g.name,
    maximum: 1,
    minimum: 0,
    products_included: [],
    ingredients_included: [],
    additional_properties: { omnivoreId: g.id, omnivoreName: g.name },
  }));

  const linkGroup = (
    optionSet: any,
    refKind: 'product' | 'ingredient',
    refId: string,
    fallbackForIngredientMax = false
  ) => {
    const groupId = modifierGroupIdFromOptionSet(optionSet);
    const base = semiParsed.find((g) => g.additional_properties.omnivoreId == groupId);
    if (!base) {
      console.warn(`[omnivore-inventory] modifier group ${groupId} not found (${refKind} ${refId}) — skipped`);
      return;
    }
    const grp: OmnivoreGroupParsed = { ...base };
    grp.minimum = optionSet.minimum == 0 && optionSet.required == true ? 1 : optionSet.minimum;
    grp.maximum = fallbackForIngredientMax
      ? optionSet.maximum
      : optionSet.maximum == 0
        ? 30
        : optionSet.maximum;
    if (refKind === 'product') grp.products_included = [refId];
    else grp.ingredients_included = [refId];

    const idx = parsed.findIndex(
      (p) =>
        p.minimum == grp.minimum &&
        p.maximum == grp.maximum &&
        p.additional_properties.omnivoreId == grp.additional_properties.omnivoreId
    );
    if (idx === -1) parsed.push(grp);
    else if (refKind === 'product') parsed[idx].products_included.push(refId);
    else parsed[idx].ingredients_included.push(refId);
  };

  // Products → groups (option_sets)
  omnivoreProducts.forEach((p) =>
    (p._embedded.option_sets || []).forEach((os: any) => linkGroup(os, 'product', p.id, false))
  );

  // Ingredients that reference groups (nested modifiers) → groups
  const modifierIds: string[] = [];
  parsed.forEach((g) => g.ingredients.forEach((i) => { if (!modifierIds.includes(i.id)) modifierIds.push(i.id); }));
  const ingredientsToImport = await getOmnivoreIngredientsToImport(client, modifierIds);
  ingredientsToImport.forEach((ing) =>
    (ing._embedded.option_sets || []).forEach((os: any) => linkGroup(os, 'ingredient', ing.id, true))
  );

  return { groups: parsed, conflicts };
}

export async function getIngredientsChangesToSyncOmnivore(
  siteId: number,
  ingredientsToImport: OmnivoreIngredient[]
): Promise<Changes> {
  const changes: Changes = { create: [], update: [], delete: [] };
  const current = await readAllBySite('ingredients', siteId);

  ingredientsToImport.forEach((ing) => {
    if (!ing.name) return;
    const found = current.find((m: any) => m.additional_properties?.omnivoreId == ing.id);
    const price = centsToDollars(ing.price_per_unit);
    const stockStatus: StockStatus = ing.in_stock === false ? 'outofstock' : 'instock';

    if (!found) {
      const omnivorePriceLevels: any[] = [];
      if ((ing._embedded?.price_levels?.length || 0) > 1) {
        ing._embedded.price_levels.forEach((pl: any) =>
          omnivorePriceLevels.push({ id: pl.id, name: pl.name, price: centsToDollars(pl.price_per_unit) })
        );
      }
      changes.create.push({
        name: ing.name,
        price,
        variations: [],
        stock_status: stockStatus,
        additional_properties: {
          omnivoreId: ing.id,
          posId: ing.pos_id,
          omnivoreIsOpen: ing.open,
          omnivorePriceLevels,
        },
      });
    } else {
      const priceDifferent = price != found.price;
      const stockDifferent = stockStatus != found.stock_status;
      if (priceDifferent || stockDifferent) {
        changes.update.push({
          id: found.id,
          name: found.name,
          price,
          stock_status: stockStatus,
          additional_properties: { ...(found.additional_properties || {}), omnivoreId: ing.id },
        });
      }
    }
  });
  // Additive: no ingredient deletes.
  return changes;
}

/** Map the pre-map Omnivore ids in each group → existing MCM ids (by omnivoreId). */
export async function getOmnivoreGroupsWithMCMReferenceMapped(
  siteId: number,
  groupsToImport: OmnivoreGroupParsed[]
): Promise<any[]> {
  const [mcmProducts, mcmIngredients] = await Promise.all([
    readAllBySite('products', siteId),
    readAllBySite('ingredients', siteId),
  ]);

  return groupsToImport.map((group) => {
    const ingredientsMapped: Array<{ id: any }> = [];
    const ingredientsIncludedMapped: any[] = [];
    const productsMapped: any[] = [];

    group.ingredients.forEach((ing) => {
      const found = mcmIngredients.find((m: any) => m.additional_properties?.omnivoreId == ing.id);
      if (found) ingredientsMapped.push({ id: found.id });
    });
    group.ingredients_included.forEach((id) => {
      const found = mcmIngredients.find((m: any) => m.additional_properties?.omnivoreId == id);
      if (found) ingredientsIncludedMapped.push(found.id);
    });
    group.products_included.forEach((id) => {
      const found = mcmProducts.find((m: any) => m.additional_properties?.omnivoreId == id);
      if (found) productsMapped.push(found.id);
    });

    return {
      ...group,
      ingredients: ingredientsMapped,
      ingredients_included: ingredientsIncludedMapped,
      products_included: productsMapped,
    };
  });
}

export async function getIngredientsGroupsChangesToSyncOmnivore(
  siteId: number,
  groupsToImport: any[]
): Promise<Changes> {
  const changes: Changes = { create: [], update: [], delete: [] };
  const mcmGroups = await readAllBySite('ingredients_groups', siteId);
  // M3: para PRESERVAR las refs NATIVAS (producto/ingrediente sin omnivoreId, adjuntado a mano al grupo) durante
  // el prune set-based, necesitamos distinguir refs managed (Omnivore) de nativas.
  const [mcmProductsForNative, mcmIngredientsForNative] = await Promise.all([
    readAllBySite('products', siteId),
    readAllBySite('ingredients', siteId),
  ]);
  const nativeProductIds = new Set(
    mcmProductsForNative.filter((p: any) => !p.additional_properties?.omnivoreId).map((p: any) => String(p.id)),
  );
  const nativeIngredientIds = new Set(
    mcmIngredientsForNative.filter((i: any) => !i.additional_properties?.omnivoreId).map((i: any) => String(i.id)),
  );

  groupsToImport.forEach((group) => {
    const found = mcmGroups.find(
      (g: any) =>
        g.minimum == group?.minimum &&
        g.maximum == group?.maximum &&
        g.additional_properties?.omnivoreId == group?.additional_properties?.omnivoreId
    );

    if (!found) {
      changes.create.push(group);
    } else {
      // F6/F5-A · AUTORITATIVO set-based (prune, NO union): el import trae el conjunto COMPLETO de refs
      // para (omnivoreId,min,max); reemplazamos en vez de unir → remueve refs muertas y adjunta el
      // modificador nuevo (found.ingredients antes nunca se reescribía → el modificador nuevo se perdía).
      // Seguro por orden en sync-ingredients.ts: products se sincronizan ANTES; ingredients se escriben
      // y re-leen fresh antes de este mapeo → sin prune transitorio de refs válidas.
      const sameSet = (a: any[], b: any[]) => {
        const A = new Set((a || []).map(String));
        const B = new Set((b || []).map(String));
        return A.size === B.size && [...A].every((x) => B.has(x));
      };
      // M3: TARGET = set Omnivore-autoritativo (group) UNIÓN las refs NATIVAS que el operador adjuntó a mano al
      // grupo existente (found, sin omnivoreId). Así prunamos solo lo Omnivore-managed ausente y NO borramos las
      // refs nativas.
      const nativeProds = (found.products_included || []).map(String).filter((id: string) => nativeProductIds.has(id));
      const nativeIncl = (found.ingredients_included || []).map(String).filter((id: string) => nativeIngredientIds.has(id));
      const foundIngredients: any[] = found.ingredients || [];
      const nativeIngs = foundIngredients.filter((i: any) => nativeIngredientIds.has(String(i.id)));

      const groupIngredients: any[] = group.ingredients || [];
      const targetProducts = [...new Set([...(group.products_included || []).map(String), ...nativeProds])];
      const targetIncluded = [...new Set([...(group.ingredients_included || []).map(String), ...nativeIncl])];
      const targetIngredients = [
        ...groupIngredients,
        ...nativeIngs.filter((n: any) => !groupIngredients.some((g: any) => String(g.id) === String(n.id))),
      ];

      const productsDiffer = !sameSet(found.products_included, targetProducts);
      const includedDiffer = !sameSet(found.ingredients_included, targetIncluded);
      const ingredientsDiffer = !sameSet(foundIngredients.map((i: any) => i.id), targetIngredients.map((i: any) => i.id));

      if (productsDiffer || includedDiffer || ingredientsDiffer) {
        changes.update.push({
          ...found,
          ingredients: targetIngredients,
          products_included: targetProducts,
          ingredients_included: targetIncluded,
          date_updated: undefined,
        });
      }
    }
  });
  return changes;
}
