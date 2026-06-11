import Decimal from 'decimal.js';
import { AxiosInstance } from 'axios';
import type { OmnivoreCategory, OmnivoreProduct, Status, StockStatus } from './types';
import {
  fetchOmnivoreMenuCategories,
  fetchOmnivoreMenuItems,
  fetchOmnivoreOosItems,
} from './menu-fetch';
import { readAllBySite } from './supabase-read';

// Ported from legacy.mcm.api/src/utilities/helpers/products-sync-helper.ts (Supabase
// path), dropping the isSupabase flag + legacy ORM, fixing the .limit() reads (full
// pagination), removing the hardcoded `siteId == "414341196"` block, and refining the
// product-price update rule (see getProductsChangesToSyncOmnivore).

const centsToDollars = (cents?: number) => new Decimal(cents || 0).div(100).toNumber();
const roundCents = (n: unknown) => Math.round(Number(n ?? 0) * 100);

export interface Changes {
  create: any[];
  update: any[];
  delete: any[];
}

/** Omnivore products with out-of-stock merged in (in_stock=false). OOS always fetched. */
export async function getOmnivoreProductsToImport(client: AxiosInstance): Promise<OmnivoreProduct[]> {
  const [products, oos] = await Promise.all([
    fetchOmnivoreMenuItems(client),
    fetchOmnivoreOosItems(client),
  ]);
  oos.forEach((o) => {
    const idx = products.findIndex((p) => p.id == o.id);
    if (idx > -1) products[idx].in_stock = false;
  });
  return products;
}

/** Only the Omnivore categories actually referenced by the imported products. */
export async function getOmnivoreCategoriesToImport(
  client: AxiosInstance,
  omnivoreProducts: OmnivoreProduct[]
): Promise<OmnivoreCategory[]> {
  const referenced = new Set<string>();
  omnivoreProducts.forEach((p) =>
    p._embedded.menu_categories.forEach((c: any) => referenced.add(c.id))
  );
  const categories = await fetchOmnivoreMenuCategories(client);
  return categories.filter((c) => referenced.has(c.id));
}

export async function getCategoriesChangesToSyncOmnivore(
  siteId: number,
  omnivoreCategoriesToImport: OmnivoreCategory[],
  defaultStatus: Status
): Promise<Changes> {
  const changes: Changes = { create: [], update: [], delete: [] };
  const currentCategories = await readAllBySite('categories', siteId);

  omnivoreCategoriesToImport.forEach((cat) => {
    const found = currentCategories.find(
      (c: any) => c.additional_properties?.omnivoreId == cat.id
    );
    if (!found) {
      changes.create.push({
        name: cat.name,
        status: defaultStatus,
        additional_properties: { omnivoreId: cat.id, posId: cat.pos_id },
      });
    }
  });
  return changes;
}

export async function getProductsChangesToSyncOmnivore(
  siteId: number,
  omnivoreProductsToImport: OmnivoreProduct[],
  defaultStatus: Status,
  priceLevelPreferences: Record<string, string>
): Promise<Changes> {
  const changes: Changes = { create: [], update: [], delete: [] };
  const [currentProducts, currentCategories] = await Promise.all([
    readAllBySite('products', siteId),
    readAllBySite('categories', siteId),
  ]);

  omnivoreProductsToImport.forEach((product) => {
    if (!product.name) return;

    const mcmProduct = currentProducts.find(
      (p: any) => product.id == p.additional_properties?.omnivoreId
    );

    let productPrice = centsToDollars(product.price_per_unit);
    let priceLevelUsed = '';

    // Preferred price level (per-site config); only if the product has ≥2 levels.
    const preferred = priceLevelPreferences[product.id];
    if (preferred && product._embedded.price_levels.length >= 2) {
      const lvl = product._embedded.price_levels.find((pl: any) => pl.id == preferred);
      if (lvl) {
        productPrice = centsToDollars(lvl.price_per_unit);
        priceLevelUsed = lvl.id;
      }
    }

    const stockStatus: StockStatus = product.in_stock === false ? 'outofstock' : 'instock';

    const omniCatIds = product._embedded.menu_categories.map((c: any) => c.id);
    const categoriesFounded = currentCategories
      .filter((c: any) => omniCatIds.includes(c.additional_properties?.omnivoreId))
      .map((c: any) => c.id);

    if (!mcmProduct) {
      changes.create.push({
        name: product.name,
        categories_id: categoriesFounded,
        price: productPrice,
        stock_status: stockStatus,
        status: defaultStatus,
        additional_properties: {
          omnivorePriceLevelUsed: priceLevelUsed,
          omnivoreId: product.id,
          posId: product.pos_id,
          omnivoreIsOpen: product.open,
          omnivoreOpenName: product.open_name,
          omnivoreProductType: product._embedded.price_levels.length > 1 ? 'variable' : 'simple',
        },
      });
    } else {
      // Price-update rule (decision): keep the MCM price if it already equals one of
      // the Omnivore price levels (operator chose a valid level); otherwise sync it.
      const validLevelCents = [
        ...product._embedded.price_levels.map((pl: any) => roundCents(centsToDollars(pl.price_per_unit))),
        roundCents(centsToDollars(product.price_per_unit)),
      ];
      const mcmPriceIsValidLevel = validLevelCents.includes(roundCents(mcmProduct.price));
      const priceShouldUpdate = !mcmPriceIsValidLevel && roundCents(mcmProduct.price) !== roundCents(productPrice);
      const stockDifferent = mcmProduct.stock_status != stockStatus;

      if (stockDifferent || priceShouldUpdate) {
        changes.update.push({
          id: mcmProduct.id,
          name: mcmProduct.name,
          stock_status: stockStatus,
          ...(priceShouldUpdate ? { price: productPrice } : {}),
          // Merge (don't replace) additional_properties so posId/omnivoreIsOpen/etc. survive.
          additional_properties: {
            ...(mcmProduct.additional_properties || {}),
            omnivoreId: product.id,
            omnivorePriceLevelUsed: priceLevelUsed,
          },
        });
      }
    }
  });

  // Additive: no product deletes (matches legacy).
  return changes;
}

export async function getPriceLevelsChangesToSyncOmnivore(
  siteId: number,
  omnivoreProductsToImport: OmnivoreProduct[]
): Promise<Changes> {
  const changes: Changes = { create: [], update: [], delete: [] };
  const [currentPriceLevels, currentProducts] = await Promise.all([
    readAllBySite('product_price_levels', siteId),
    readAllBySite('products', siteId),
  ]);

  omnivoreProductsToImport.forEach((omnivoreProduct) => {
    const productInMcm = currentProducts.find(
      (p: any) => p.additional_properties?.omnivoreId === omnivoreProduct.id
    );
    if (!productInMcm) return;

    const productId = productInMcm.id;
    const priceLevels = omnivoreProduct._embedded?.price_levels || [];

    if (priceLevels.length === 0) {
      const defaultPrice = centsToDollars(omnivoreProduct.price_per_unit);
      const existingDefault = currentPriceLevels.find(
        (pl: any) => pl.product_id == productId && (!pl.pos_id || pl.pos_id === '')
      );
      if (!existingDefault) {
        changes.create.push({
          product_id: productId, site_id: siteId, pos_id: null,
          code: 'Default', price: defaultPrice, is_default: true,
        });
      } else if (existingDefault.price !== defaultPrice) {
        changes.update.push({
          id: existingDefault.id, product_id: productId, site_id: siteId, pos_id: null,
          code: 'Default', price: defaultPrice, is_default: true,
        });
      }
      return;
    }

    // Resolve which pos_id is default: respect the user's manual choice if it still
    // exists in Omnivore; else fall back to Omnivore's primary price / first level.
    const currentDefault = currentPriceLevels.find(
      (pl: any) => pl.product_id == productId && pl.is_default === true
    );
    const omnivorePosIds = priceLevels.map((pl: any) => pl.id);
    let defaultPosId: string | null = null;
    if (currentDefault && omnivorePosIds.includes(currentDefault.pos_id)) {
      defaultPosId = currentDefault.pos_id;
    } else {
      const matched = priceLevels.find((pl: any) => pl.price_per_unit === omnivoreProduct.price_per_unit);
      defaultPosId = matched?.id ?? priceLevels[0]?.id ?? null;
    }

    priceLevels.forEach((priceLevel: any) => {
      const price = centsToDollars(priceLevel.price_per_unit);
      const isDefault = priceLevel.id === defaultPosId;
      const existing = currentPriceLevels.find(
        (pl: any) => pl.product_id == productId && pl.pos_id == priceLevel.id
      );
      if (!existing) {
        changes.create.push({
          product_id: productId, site_id: siteId, pos_id: priceLevel.id,
          code: priceLevel.name, price, is_default: isDefault,
        });
      } else if (existing.price !== price || existing.is_default !== isDefault || existing.code !== priceLevel.name) {
        changes.update.push({
          id: existing.id, product_id: productId, site_id: siteId, pos_id: priceLevel.id,
          code: priceLevel.name, price, is_default: isDefault,
        });
      }
    });
  });

  // Delete price levels that no longer exist in Omnivore.
  currentPriceLevels.forEach((cur: any) => {
    const productInMcm = currentProducts.find((p: any) => p.id === cur.product_id);
    if (!productInMcm) return;
    const omnivoreProduct = omnivoreProductsToImport.find(
      (op) => op.id === productInMcm.additional_properties?.omnivoreId
    );
    if (!omnivoreProduct) return;
    const omnivorePriceLevels = omnivoreProduct._embedded?.price_levels || [];

    if (!cur.pos_id || cur.pos_id === '') {
      // auto-created default → delete only once the product has real Omnivore levels
      if (omnivorePriceLevels.length > 0) changes.delete.push(cur);
      return;
    }
    if (!omnivorePriceLevels.some((pl: any) => pl.id === cur.pos_id)) {
      changes.delete.push(cur);
    }
  });

  return changes;
}
