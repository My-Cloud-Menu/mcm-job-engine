import Decimal from 'decimal.js';
import { AxiosInstance } from 'axios';
import type { OmnivoreIngredient, OmnivoreProduct, StockStatus } from './types';
import { fetchOmnivoreModifiers, fetchOmnivoreModifierGroups, fetchOmnivoreOosModifiers } from './menu-fetch';
import { readAllBySite } from './supabase-read';
import type { Changes } from './products-helper';

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
): Promise<OmnivoreGroupParsed[]> {
  const parsed: OmnivoreGroupParsed[] = [];
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

  return parsed;
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
      const hasProductsRef = group.products_included.every((id: any) =>
        (found.products_included || []).map(String).includes(String(id))
      );
      const mcmIngIds = (found.ingredients || []).map((i: any) => i.id);
      const hasIngredientsRef =
        group.ingredients.length === (found.ingredients?.length || 0) &&
        group.ingredients.every((i: any) => mcmIngIds.includes(i.id));

      if (!hasProductsRef || !hasIngredientsRef) {
        const newProducts = Array.from(new Set([
          ...((found.products_included || []).map(String)),
          ...group.products_included.map(String),
        ]));
        const newIngredients = Array.from(new Set([
          ...(found.ingredients_included || []),
          ...group.ingredients_included,
        ]));
        changes.update.push({
          ...found,
          products_included: newProducts,
          ingredients_included: newIngredients,
          date_updated: undefined,
        });
      }
    }
  });
  return changes;
}
