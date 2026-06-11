import { supabase } from '../../../../lib/supabase';
import { nextIdBase } from './supabase-read';
import type { Changes } from './products-helper';

// Ported from legacy products-sync-service.ts (Supabase path). Dropped the legacy
// ORM, S3 image upload, and the per-row 50–100ms sleeps. Fixed id generation
// (categories omit id → identity; products use max(id)+1, not random). Inserts are
// chunked array-inserts (one request per chunk) instead of per-row — ~1130 round
// trips → a handful (the legacy per-row loop took ~90s for 535 products).

const CHUNK = 500;

function chunk<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function formatSlug(name: string): string {
  return (name || '')
    .toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function batchCategories(siteId: number, batch: Changes): Promise<void> {
  // categories.id is an identity column → omit it (let Postgres generate).
  const rows = batch.create.map((c) => ({
    site_id: siteId,
    name: c.name,
    status: c.status || 'published',
    slug: formatSlug(c.name),
    additional_properties: c.additional_properties || {},
    description: c.description ?? null,
    ...(c.image !== undefined ? { image: c.image } : {}),
    ...(c.menu_order !== undefined ? { menu_order: c.menu_order } : {}),
  }));
  for (const part of chunk(rows)) {
    if (part.length) await supabase.from('categories').insert(part).throwOnError();
  }
}

export async function batchProducts(siteId: number, batch: Changes): Promise<void> {
  let nextId = await nextIdBase('products', siteId);
  const rows = batch.create.map((p) => ({
    id: nextId++,
    site_id: siteId,
    name: p.name,
    status: p.status || 'published',
    stock_status: p.stock_status || 'instock',
    price: p.price,
    additional_properties: p.additional_properties || {},
    categories_id: (p.categories_id || []).map((id: any) => id.toString()),
    images: p.images ?? [],
    description: p.description ?? null,
    tags: p.tags || [],
    sku: p.sku || '',
    ...(p.tax_class ? { tax_class: p.tax_class } : {}),
  }));
  for (const part of chunk(rows)) {
    if (part.length) await supabase.from('products').insert(part).throwOnError();
  }

  // Updates vary per row (usually few/none) → keep individual.
  for (const p of batch.update) {
    await supabase.from('products').update({
      name: p.name,
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.price !== undefined ? { price: p.price } : {}),
      ...(p.images !== undefined ? { images: p.images } : {}),
      stock_status: p.stock_status,
      additional_properties: p.additional_properties || undefined,
    }).eq('id', p.id).eq('site_id', siteId).throwOnError();
  }
  // Additive: no product deletes.
}

/**
 * Price levels. Order matters to satisfy UNIQUE (site_id, product_id) WHERE is_default:
 * delete → update(clear default) → create → update(set default).
 */
export async function batchPriceLevels(batch: Changes): Promise<void> {
  const updatesClearDefault = batch.update.filter((pl) => pl.is_default !== true);
  const updatesSetDefault = batch.update.filter((pl) => pl.is_default === true);

  const deleteIds = batch.delete.map((pl) => pl.id);
  for (const part of chunk(deleteIds)) {
    if (part.length) await supabase.from('product_price_levels').delete().in('id', part).throwOnError();
  }

  for (const pl of updatesClearDefault) {
    await supabase.from('product_price_levels')
      .update({ code: pl.code, price: pl.price, is_default: pl.is_default })
      .eq('id', pl.id).throwOnError();
  }

  const createRows = batch.create.map((pl) => ({
    product_id: pl.product_id, site_id: pl.site_id, pos_id: pl.pos_id,
    code: pl.code, price: pl.price, is_default: pl.is_default,
  }));
  for (const part of chunk(createRows)) {
    if (part.length) await supabase.from('product_price_levels').insert(part).throwOnError();
  }

  for (const pl of updatesSetDefault) {
    await supabase.from('product_price_levels')
      .update({ code: pl.code, price: pl.price, is_default: pl.is_default })
      .eq('id', pl.id).throwOnError();
  }
}
