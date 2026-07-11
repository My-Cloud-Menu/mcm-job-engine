import { AxiosInstance } from 'axios';
import type { OmnivoreProduct, Status, SyncConflict } from './types';
import {
  getOmnivoreProductsToImport,
  getOmnivoreCategoriesToImport,
  getCategoriesChangesToSyncOmnivore,
  getProductsChangesToSyncOmnivore,
  getPriceLevelsChangesToSyncOmnivore,
} from './products-helper';
import { batchCategories, batchProducts, batchPriceLevels } from './products-write';

export interface SyncProductsParams {
  site_id: number;
  client: AxiosInstance;
  set_available_to_buy?: boolean; // true → products created 'published'; false → 'draft'
  only_include_prices_and_stock_changes?: boolean;
  archive_removed?: boolean; // F7: soft-archive de productos ausentes del POS (config-gated)
  skip_category_types?: string[]; // N8: tipos de menu_category_type a saltar (default [] = importar todo)
}

export interface SyncProductsResult {
  productsToImport: OmnivoreProduct[]; // passed to the ingredients/groups step
  categories: { created: number };
  products: { created: number; updated: number };
  price_levels: { created: number; updated: number; deleted: number };
  conflicts: SyncConflict[];
}

/**
 * Ported from legacy syncOmnivoreProductsV2 (Supabase path), always-apply (no
 * isSupabase / confirm_changes flags). Order is load-bearing: categories →
 * products → price-levels, re-reading MCM between steps so each maps refs by
 * additional_properties.omnivoreId.
 */
export async function syncOmnivoreProductsV2(params: SyncProductsParams): Promise<SyncProductsResult> {
  const defaultStatus: Status = params.set_available_to_buy ? 'published' : 'draft';

  // 1. Omnivore products (+ OOS merged)
  const productsToImport = await getOmnivoreProductsToImport(params.client);

  // 2-4. Categories (referenced by products) → changes → write
  const categoriesToImport = await getOmnivoreCategoriesToImport(params.client, productsToImport, params.skip_category_types ?? []);
  const categoriesChanges = await getCategoriesChangesToSyncOmnivore(
    params.site_id, categoriesToImport, defaultStatus
  );
  await batchCategories(params.site_id, categoriesChanges);

  // 5-6. Products (now categories exist for ref-mapping) → changes → write
  // F7: allowArchive lleva el empty-guard (productsToImport.length>0) y NUNCA archiva en modo only_include.
  const allowArchive = !!params.archive_removed && productsToImport.length > 0 && !params.only_include_prices_and_stock_changes;
  const productsChanges = await getProductsChangesToSyncOmnivore(
    params.site_id, productsToImport, defaultStatus, allowArchive
  );
  if (params.only_include_prices_and_stock_changes) {
    productsChanges.create = [];
    productsChanges.delete = [];
  }
  await batchProducts(params.site_id, productsChanges);

  // 7-8. Price levels (now products exist for ref-mapping) → changes → write
  const priceLevelsChanges = await getPriceLevelsChangesToSyncOmnivore(params.site_id, productsToImport);
  await batchPriceLevels(priceLevelsChanges);

  return {
    productsToImport,
    categories: { created: categoriesChanges.create.length },
    products: { created: productsChanges.create.length, updated: productsChanges.update.length },
    price_levels: {
      created: priceLevelsChanges.create.length,
      updated: priceLevelsChanges.update.length,
      deleted: priceLevelsChanges.delete.length,
    },
    conflicts: priceLevelsChanges.conflicts,
  };
}
