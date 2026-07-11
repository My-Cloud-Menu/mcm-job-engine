import Decimal from 'decimal.js';
import { AxiosInstance } from 'axios';
import type { OmnivoreCategory, OmnivoreProduct, Status, StockStatus, SyncConflict } from './types';
import {
  fetchOmnivoreMenuCategories,
  fetchOmnivoreMenuItems,
  fetchOmnivoreOosItems,
} from './menu-fetch';
import { readAllBySite } from './supabase-read';
import { logger } from '../../../../lib/logger';
import { omniArchiveIsSafe } from '../archive-guard';

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

/**
 * Only the Omnivore categories actually referenced by the imported products.
 * N8: skipCategoryTypes filtra por _embedded.menu_category_type.id (p.ej. 'sales','retail').
 * Default [] = importar TODO (sin filtro) — un filtro activo por defecto rompería.
 * NOTA (alcance): filtra el REGISTRO de categoría, no el producto. Un producto que también está en una categoría
 * de tipo NO-skipeado (p.ej. 'ALL'/'general' compartida) SIGUE importándose. Filtrar productos por tipo de
 * categoría es un follow-up (requiere decisión de producto).
 */
export async function getOmnivoreCategoriesToImport(
  client: AxiosInstance,
  omnivoreProducts: OmnivoreProduct[],
  skipCategoryTypes: string[] = []
): Promise<OmnivoreCategory[]> {
  const referenced = new Set<string>();
  omnivoreProducts.forEach((p) =>
    p._embedded.menu_categories.forEach((c: any) => referenced.add(c.id))
  );
  const skip = new Set(skipCategoryTypes);
  const categories = await fetchOmnivoreMenuCategories(client);
  return categories.filter(
    (c) => referenced.has(c.id) && (skip.size === 0 || !skip.has(c._embedded?.menu_category_type?.id ?? ''))
  );
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
        additional_properties: {
          omnivoreId: cat.id,
          posId: cat.pos_id,
          omnivoreLevel: cat.level ?? 0, // N8: jerarquía
          omnivoreCategoryType: cat._embedded?.menu_category_type?.id ?? null, // N8: tipo (general/sales/retail)
        },
      });
    }
  });
  return changes;
}

export async function getProductsChangesToSyncOmnivore(
  siteId: number,
  omnivoreProductsToImport: OmnivoreProduct[],
  defaultStatus: Status,
  allowArchive = false, // F7: soft-archive de productos ausentes del POS (config-gated + empty-guard en el caller)
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

    // F9: priceLevelPreferences (dead config — siempre {} en prod) removido. Superseded por el picker
    // product_price_levels que getPriceLevelsChangesToSyncOmnivore ya respeta. productPrice = default POS.
    const productPrice = centsToDollars(product.price_per_unit);
    const priceLevelUsed = '';

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
          omnivoreName: product.name, // F8: snapshot del nombre POS para detectar rename
          omnivoreProductType: product._embedded.price_levels.length > 1 ? 'variable' : 'simple',
          omnivoreBarcodes: Array.isArray(product.barcodes) ? product.barcodes : [], // N8: barcodes (array) del POS
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
      // F8: adoptar el rename del POS SOLO si MCM no overrideó el nombre (additional_properties.nameOverridden).
      const nameOverridden = !!mcmProduct.additional_properties?.nameOverridden;
      // M2 seed-only: si el producto managed NO tiene snapshot omnivoreName todavía (1er sync tras F8), NO
      // consideramos que "cambió" el nombre → evita (a) update+trigger masivo de todos los productos y (b) adoptar/
      // pisar un rename manual. El snapshot se siembra perezosamente en el próximo update de stock/precio
      // (additional_properties abajo ya escribe omnivoreName: product.name). Solo detectamos cambios REALES cuando
      // ya hay un snapshot previo contra el cual comparar.
      const omnivoreNameChanged =
        mcmProduct.additional_properties?.omnivoreName != null &&
        mcmProduct.additional_properties.omnivoreName !== product.name;
      const adoptName = !nameOverridden && omnivoreNameChanged;

      if (stockDifferent || priceShouldUpdate || omnivoreNameChanged) {
        changes.update.push({
          id: mcmProduct.id,
          name: adoptName ? product.name : mcmProduct.name,
          stock_status: stockStatus,
          ...(priceShouldUpdate ? { price: productPrice } : {}),
          // Merge (don't replace) additional_properties so posId/omnivoreIsOpen/etc. survive.
          additional_properties: {
            ...(mcmProduct.additional_properties || {}),
            omnivoreId: product.id,
            omnivorePriceLevelUsed: priceLevelUsed,
            omnivoreName: product.name, // F8: refrescar el snapshot del nombre POS
            // N8/D3: refrescar barcodes OPORTUNISTAMENTE (cuando el update ya dispara por stock/precio/nombre);
            // no se añade `barcodesDiffer` como trigger nuevo para evitar el update-storm del 1er sync (como M2).
            // Preserva los barcodes existentes si el POS no los envía en este fetch.
            omnivoreBarcodes: Array.isArray(product.barcodes)
              ? product.barcodes
              : (mcmProduct.additional_properties?.omnivoreBarcodes ?? []),
          },
        });
      }
    }
  });

  // F7 · Product soft-archive (config-gated allowArchive + empty-guard en el caller). Un producto managed cuyo
  // omnivoreId ya NO está en el fetch crudo completo de /menu/items → status='draft' + archived (lo esconde el
  // reader menus-service). SEGURO: importedIds sale del fetch crudo completo (sin falso-huérfano, a diferencia
  // del ingredient-archive que quedó diferido). No toca productos nativos MCM (sin omnivoreId).
  if (allowArchive) {
    const importedIds = new Set(omnivoreProductsToImport.map((p) => String(p.id)));
    // Gap2 · guard de fetch degradado: si el /menu/items encogió > cap sobre los productos managed actuales,
    // es sospechoso (fetch parcial / cap de paginación) → NO archivar (evita esconder ~todo el menú, que además
    // no se auto-cura). managedCount===0 → no hay nada que archivar (no-op, sin warn).
    const managedCount = currentProducts.filter((p: any) => p.additional_properties?.omnivoreId).length;
    if (managedCount > 0 && !omniArchiveIsSafe(importedIds.size, managedCount)) {
      logger.warn(
        { site_id: siteId, fetched: importedIds.size, managed: managedCount },
        'omnivore product soft-archive SKIPPED: fetch parcial/degradado sospechoso (shrink > cap)'
      );
    } else {
      currentProducts.forEach((p: any) => {
        const oid = p.additional_properties?.omnivoreId;
        if (!oid || importedIds.has(String(oid))) return;
        if (p.status === 'draft' || p.additional_properties?.archived) return;
        changes.update.push({
          id: p.id,
          name: p.name,
          status: 'draft',
          additional_properties: { ...(p.additional_properties || {}), archived: true },
        });
      });
    }
  }

  return changes;
}

export async function getPriceLevelsChangesToSyncOmnivore(
  siteId: number,
  omnivoreProductsToImport: OmnivoreProduct[]
): Promise<Changes & { conflicts: SyncConflict[] }> {
  const changes: Changes = { create: [], update: [], delete: [] };
  const conflicts: SyncConflict[] = [];
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
      // F13/F12(a): el price level que el operador eligió como default fue BORRADO en el POS pero MCM aún lo
      // referencia → fallback (abajo) + registrar el override inválido. Excluye el default auto-creado
      // (pos_id null/'') que es transición válida, no override.
      const matched = priceLevels.find((pl: any) => pl.price_per_unit === omnivoreProduct.price_per_unit);
      defaultPosId = matched?.id ?? priceLevels[0]?.id ?? null;
      if (currentDefault && currentDefault.pos_id != null && currentDefault.pos_id !== '') {
        conflicts.push({
          conflict_type: 'price_level_deleted',
          entity_type: 'product',
          entity_omnivore_id: String(currentDefault.pos_id),
          entity_mcm_id: String(productId),
          detail: {
            deletedCode: currentDefault.code ?? null,
            productOmnivoreId: omnivoreProduct.id,
            fallbackPosId: defaultPosId,
          },
        });
      }
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

  return { ...changes, conflicts };
}
