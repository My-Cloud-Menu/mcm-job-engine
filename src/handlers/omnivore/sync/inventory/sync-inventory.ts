import { AxiosInstance } from 'axios';
import { syncOmnivoreProductsV2 } from './sync-products';
import { syncOmnivoreIngredientsAndGroupsV2 } from './sync-ingredients';
import type { SyncConflict } from './types';

export interface SyncInventoryParams {
  site_id: number;
  client: AxiosInstance;
  set_available_to_buy?: boolean; // default true → products published
  only_include_prices_and_stock_changes?: boolean;
  archive_removed?: boolean; // F7: soft-archive de productos ausentes del POS (config-gated)
  skip_category_types?: string[]; // N8: tipos de menu_category_type a saltar (default [] = importar todo)
}

export interface SyncInventoryResult {
  categories: { created: number };
  products: { created: number; updated: number };
  price_levels: { created: number; updated: number; deleted: number };
  ingredients: { created: number; updated: number };
  groups: { created: number; updated: number };
  conflicts: SyncConflict[];
}

/**
 * Full Omnivore inventory/menu sync: categories → products → price-levels →
 * ingredients (modifiers) → modifier groups. Each entity maps refs by
 * additional_properties.omnivoreId; additive (no deletes of products/ingredients/
 * groups; price-levels reconcile). Idempotent.
 */
export async function syncOmnivoreInventory(params: SyncInventoryParams): Promise<SyncInventoryResult> {
  const prod = await syncOmnivoreProductsV2({
    site_id: params.site_id,
    client: params.client,
    set_available_to_buy: params.set_available_to_buy ?? true,
    only_include_prices_and_stock_changes: params.only_include_prices_and_stock_changes,
    archive_removed: params.archive_removed,
    skip_category_types: params.skip_category_types,
  });

  const ingr = await syncOmnivoreIngredientsAndGroupsV2({
    site_id: params.site_id,
    client: params.client,
    omnivoreProducts: prod.productsToImport,
    only_include_prices_and_stock_changes: params.only_include_prices_and_stock_changes,
  });

  return {
    categories: prod.categories,
    products: prod.products,
    price_levels: prod.price_levels,
    ingredients: ingr.ingredients,
    groups: ingr.groups,
    conflicts: [...prod.conflicts, ...ingr.conflicts],
  };
}
