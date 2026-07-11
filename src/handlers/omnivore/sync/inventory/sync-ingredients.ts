import { AxiosInstance } from 'axios';
import type { OmnivoreProduct, SyncConflict } from './types';
import {
  getOmnivoreIngredientGroupToImport,
  getOmnivoreIngredientsToImport,
  getIngredientsChangesToSyncOmnivore,
  getOmnivoreGroupsWithMCMReferenceMapped,
  getIngredientsGroupsChangesToSyncOmnivore,
} from './ingredients-helper';
import { batchIngredients, batchIngredientsGroup } from './ingredients-write';

export interface SyncIngredientsResult {
  ingredients: { created: number; updated: number };
  groups: { created: number; updated: number };
  conflicts: SyncConflict[];
}

/**
 * Ported from legacy syncOmnivoreIngredientsAndGroupsV2 (Supabase path). Order is
 * load-bearing: build groups (from products' option_sets) → ingredients → write
 * ingredients → map group refs to MCM ids (needs ingredients written) → write groups.
 * Must run AFTER products are synced (groups reference product ids by omnivoreId).
 */
export async function syncOmnivoreIngredientsAndGroupsV2(params: {
  site_id: number;
  client: AxiosInstance;
  omnivoreProducts: OmnivoreProduct[];
  only_include_prices_and_stock_changes?: boolean;
}): Promise<SyncIngredientsResult> {
  // 1. Groups to import (parsed from modifier_groups + products/ingredients option_sets)
  const { groups: groupsToImport, conflicts } = await getOmnivoreIngredientGroupToImport(
    params.client, params.site_id, params.omnivoreProducts
  );

  // 2. Ingredient (modifier) ids referenced by those groups
  const ids = new Set<string>();
  groupsToImport.forEach((g) => {
    g.ingredients.forEach((i) => ids.add(i.id));
    g.ingredients_included.forEach((id) => ids.add(id));
  });

  // 2.2 Ingredients (modifiers) to import (+ OOS)
  const ingredientsToImport = await getOmnivoreIngredientsToImport(params.client, [...ids]);

  // 3-4. Ingredient changes → write
  const ingredientsChanges = await getIngredientsChangesToSyncOmnivore(params.site_id, ingredientsToImport);
  if (params.only_include_prices_and_stock_changes) {
    ingredientsChanges.create = [];
    ingredientsChanges.delete = [];
  }
  await batchIngredients(params.site_id, ingredientsChanges);

  // 5. Map group refs to MCM ids (ingredients now exist)
  const groupsMapped = await getOmnivoreGroupsWithMCMReferenceMapped(params.site_id, groupsToImport);

  // 6-7. Group changes → write
  const groupsChanges = await getIngredientsGroupsChangesToSyncOmnivore(params.site_id, groupsMapped);
  if (params.only_include_prices_and_stock_changes) {
    groupsChanges.create = [];
    groupsChanges.update = [];
    groupsChanges.delete = [];
  }
  await batchIngredientsGroup(params.site_id, groupsChanges);

  return {
    ingredients: { created: ingredientsChanges.create.length, updated: ingredientsChanges.update.length },
    groups: { created: groupsChanges.create.length, updated: groupsChanges.update.length },
    conflicts,
  };
}
