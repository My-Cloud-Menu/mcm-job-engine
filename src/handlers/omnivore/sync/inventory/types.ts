// Omnivore menu entity shapes (ported from legacy.mcm.api omnivore-service.ts).
// These are the raw HAL shapes the reconcile consumes (price_per_unit in CENTS).

export interface OmnivoreCategory {
  id: string;
  name: string;
  pos_id: string;
  level?: number;
  // Presente en el fetch completo /menu/categories (no siempre en los embebidos de un producto).
  _embedded?: { menu_category_type?: { id: string; name?: string } };
}

export interface OmnivoreProduct {
  id: string;
  name: string;
  in_stock: boolean;
  open: boolean;
  open_name?: string;
  pos_id?: string;
  price_per_unit?: number; // cents
  barcodes?: string[];
  _embedded: {
    menu_categories: OmnivoreCategory[];
    price_levels: any[]; // { id, name, price_per_unit }
    option_sets: any[];  // { minimum, maximum, required, _links.modifier_group.href }
  };
}

export interface OmnivoreIngredient {
  id: string;
  name: string;
  open: boolean;
  in_stock?: boolean;
  pos_id?: string;
  price_per_unit?: number; // cents
  _embedded: {
    option_sets: any[];
    price_levels: any[];
  };
}

export interface OmnivoreIngredientGroup {
  id: string;
  name: string;
  pos_id?: string;
  _embedded: {
    modifiers: any[]; // each { id, ... }
  };
}

/** Out-of-stock list items only need an id to flip in_stock=false. */
export interface OmnivoreOosItem {
  id: string;
}

export type Status = 'published' | 'draft';
export type StockStatus = 'instock' | 'outofstock';

/** Override INVÁLIDO detectado durante el sync (referencia MCM a data del POS que ya no existe). */
export interface SyncConflict {
  // 'price_level_deleted' → detectado (products-helper): el price-level default que MCM eligió se borró del POS.
  // 'hidden_modifier_missing' → RESERVADO (schema + CHECK listos): un modificador con override `hidden` de MCM
  //   cuyo omnivoreId desapareció del POS. NO se detecta aún: hacerlo fiable requiere la lista COMPLETA de
  //   modifiers de Omnivore (el import está filtrado a los referenciados → falsos positivos). Pendiente de
  //   definir semántica + plumbing de la lista completa antes de emitirlo (no inventar la detección).
  conflict_type: 'price_level_deleted' | 'hidden_modifier_missing';
  entity_type: 'product' | 'modifier';
  entity_omnivore_id: string;
  entity_mcm_id?: string | null;
  detail?: Record<string, unknown>;
}
