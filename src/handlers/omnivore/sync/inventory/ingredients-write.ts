import { supabase } from '../../../../lib/supabase';
import { nextIdBase } from './supabase-read';
import type { Changes } from './products-helper';

// Ported from legacy ingredients-sync-service.ts batch writers (Supabase path).
// Dropped ORM/sleeps; id-gen via max(id)+1 (not random); chunked array inserts.

const CHUNK = 500;
function chunk<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function batchIngredients(siteId: number, batch: Changes): Promise<void> {
  let nextId = await nextIdBase('ingredients', siteId);
  const rows = batch.create.map((i) => ({
    id: nextId++,
    site_id: siteId,
    name: i.name,
    price: i.price,
    stock_status: i.stock_status || 'instock',
    additional_properties: i.additional_properties || {},
    variations: i.variations || [],
  }));
  for (const part of chunk(rows)) {
    if (part.length) await supabase.from('ingredients').insert(part).throwOnError();
  }

  for (const i of batch.update) {
    await supabase.from('ingredients').update({
      name: i.name,
      price: i.price,
      stock_status: i.stock_status,
      additional_properties: i.additional_properties,
    }).eq('id', i.id).eq('site_id', siteId).throwOnError();
  }
  // Additive: no ingredient deletes.
}

export async function batchIngredientsGroup(siteId: number, batch: Changes): Promise<void> {
  let nextId = await nextIdBase('ingredients_groups', siteId);
  const rows = batch.create.map((g) => ({
    id: nextId++,
    site_id: g.site_id ?? siteId,
    name: g.name,
    label: g.label,
    status: g.status || 'published',
    minimum: g.minimum,
    maximum: g.maximum,
    ingredients: g.ingredients || [],
    products_included: (g.products_included || []).map(String), // text[] column
    ingredients_included: g.ingredients_included || [],          // bigint[] column
    additional_properties: g.additional_properties || {},
  }));
  for (const part of chunk(rows)) {
    if (part.length) await supabase.from('ingredients_groups').insert(part).throwOnError();
  }

  for (const g of batch.update) {
    await supabase.from('ingredients_groups').update({
      name: g.name,
      label: g.label,
      status: g.status,
      minimum: g.minimum,
      maximum: g.maximum,
      ingredients: g.ingredients,
      products_included: (g.products_included || []).map(String),
      ingredients_included: g.ingredients_included,
      additional_properties: g.additional_properties,
    }).eq('id', g.id).eq('site_id', g.site_id ?? siteId).throwOnError();
  }
  // Additive: no group deletes.
}
