import { AxiosInstance } from 'axios';
import type {
  OmnivoreCategory,
  OmnivoreProduct,
  OmnivoreIngredient,
  OmnivoreIngredientGroup,
  OmnivoreOosItem,
} from './types';

// Omnivore menu endpoints embed their sub-resources by default (no ?fields needed):
//   /menu/items        → _embedded.menu_items[]   (each: _embedded.{menu_categories, price_levels, option_sets})
//   /menu/modifiers    → _embedded.modifiers[]    (each: _embedded.{option_sets, price_levels})
//   /menu/modifier_groups → _embedded.modifier_groups[] (each: _embedded.modifiers[])
//   /menu/categories   → _embedded.categories[]
//   /menu/oos/items    → _embedded.menu_items[]   (out of stock)
//   /menu/oos/modifiers→ _embedded.modifiers[]    (out of stock)
// Ported from legacy.mcm.api/src/services/omnivore-service.ts (Supabase path), via
// the shared HAL pagination pattern. A small inter-page delay is a courtesy to the
// Omnivore API (avoids 429s); it is NOT the per-row sleep we dropped from the writes.

const PAGE_DELAY_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Paginated HAL fetch following `_links.next.href` until exhausted. */
async function fetchMenuList<T>(
  client: AxiosInstance,
  path: string,
  embeddedKey: string
): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | null = null;
  do {
    const res: { data: any } = nextUrl ? await client.get(nextUrl) : await client.get(path);
    const page = res.data?._embedded?.[embeddedKey];
    if (Array.isArray(page)) items.push(...page);
    nextUrl = res.data?._links?.next?.href ?? null;
    if (nextUrl) await sleep(PAGE_DELAY_MS);
  } while (nextUrl);
  return items;
}

export const fetchOmnivoreMenuCategories = (c: AxiosInstance) =>
  fetchMenuList<OmnivoreCategory>(c, '/menu/categories', 'categories');

export const fetchOmnivoreMenuItems = (c: AxiosInstance) =>
  fetchMenuList<OmnivoreProduct>(c, '/menu/items', 'menu_items');

export const fetchOmnivoreModifiers = (c: AxiosInstance) =>
  fetchMenuList<OmnivoreIngredient>(c, '/menu/modifiers', 'modifiers');

export const fetchOmnivoreModifierGroups = (c: AxiosInstance) =>
  fetchMenuList<OmnivoreIngredientGroup>(c, '/menu/modifier_groups', 'modifier_groups');

/** Out-of-stock menu items (always fetched; no sandbox skip). */
export const fetchOmnivoreOosItems = (c: AxiosInstance) =>
  fetchMenuList<OmnivoreOosItem>(c, '/menu/oos/items', 'menu_items');

/** Out-of-stock modifiers (always fetched; no sandbox skip). */
export const fetchOmnivoreOosModifiers = (c: AxiosInstance) =>
  fetchMenuList<OmnivoreOosItem>(c, '/menu/oos/modifiers', 'modifiers');
