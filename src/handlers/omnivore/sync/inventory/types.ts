// Omnivore menu entity shapes (ported from legacy.mcm.api omnivore-service.ts).
// These are the raw HAL shapes the reconcile consumes (price_per_unit in CENTS).

export interface OmnivoreCategory {
  id: string;
  name: string;
  pos_id: string;
  level?: number;
}

export interface OmnivoreProduct {
  id: string;
  name: string;
  in_stock: boolean;
  open: boolean;
  open_name?: string;
  pos_id?: string;
  price_per_unit?: number; // cents
  barcodes?: string;
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
