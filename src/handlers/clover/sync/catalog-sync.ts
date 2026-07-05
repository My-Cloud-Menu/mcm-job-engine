import { AxiosInstance } from 'axios';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { acquireCloverCatalogToken } from './rate-limit';

/**
 * Clover → MCM CATALOG sync (categories, products, item stock/86). ADDITIVE, source of truth
 * = Clover (product decision #2). Mirrors the proven edge mapping in
 * `mcm-edge-functions/.../clover-helper.ts::syncCategories/syncProducts`, with two deliberate
 * hardening changes over the edge:
 *   - **Soft-archive, never DELETE** (G9): rows whose cloverId disappears from a COMPLETE sweep
 *     are set status='draft' + additional_properties.cloverArchived=true (products also
 *     stock_status='outofstock'). The edge hard-deletes — dangerous on a partial page.
 *   - **Rate-limited, paginated with an explicit cap+log** (G1/G6): no silent truncation.
 * Matching key everywhere: `additional_properties.cloverId` (mirrors `omnivoreId`).
 * Every read/write is scoped by `site_id`.
 */

export interface CatalogSyncStats {
  total: number;
  created: number;
  updated: number;
  archived: number;
  skipped: number;
}
const emptyStats = (): CatalogSyncStats => ({ total: 0, created: 0, updated: 0, archived: 0, skipped: 0 });

const PAGE = 100;
const MAX_PAGES = 60; // 6000 elements hard cap; logs if reached (G6, no silent truncation)

/**
 * Offset-paginated fetch of a Clover collection, rate-limited per site. Returns the elements
 * plus `complete` (false if the cap was hit — callers MUST NOT soft-archive on an incomplete
 * sweep, G9). NOTE: Clover's offset is effectively capped (~1000); >MAX_PAGES catalogs need
 * modifiedTime-window cursor pagination — logged as `clover_catalog_pagination_capped` and
 * documented as a production follow-up (BLOQUEOS).
 */
export async function fetchAllCloverElements(
  client: AxiosInstance,
  siteId: number,
  path: string,
  expand?: string,
  opts?: { cursorField?: string }
): Promise<{ elements: any[]; complete: boolean }> {
  // CURSOR mode (opts.cursorField = a UNIQUE orderable field, use 'id'): paginate by
  // `orderBy=<field>&filter=<field>>lastValue` instead of offset, so a catalog >~1000 items
  // (where Clover's offset silently caps) is fully swept. `id` is unique → strict `>` guarantees
  // forward progress with NO tie problem (modifiedTime fails here: the sandbox's 114 items share
  // a modifiedTime, a >PAGE tie-cluster). Verified: Clover supports orderBy=id + filter=id>X.
  if (opts?.cursorField) {
    const cursorField = opts.cursorField;
    const elements: any[] = [];
    const seen = new Set<string>();
    let lastCursor: string | null = null;
    let pages = 0;
    for (;;) {
      await acquireCloverCatalogToken(siteId);
      const q = new URLSearchParams({ limit: String(PAGE), orderBy: cursorField });
      if (expand) q.set('expand', expand);
      if (lastCursor != null) q.set('filter', `${cursorField}>${lastCursor}`); // strict > (unique field)
      const res = await client.get<{ elements?: any[] }>(`${path}?${q.toString()}`);
      const batch = res.data?.elements ?? [];
      let added = 0;
      let newLast: string | null = lastCursor;
      for (const el of batch) {
        newLast = String(el?.[cursorField] ?? el?.id); // orderBy asc → last element carries the max
        const id = String(el?.id);
        if (!seen.has(id)) { seen.add(id); elements.push(el); added += 1; }
      }
      pages += 1;
      if (batch.length < PAGE) return { elements, complete: true };
      if (newLast === lastCursor || added === 0) {
        logger.warn({ site_id: siteId, path, fetched: elements.length }, 'clover_catalog_cursor_stuck');
        return { elements, complete: false };
      }
      if (pages >= MAX_PAGES) {
        logger.warn({ site_id: siteId, path, fetched: elements.length }, 'clover_catalog_pagination_capped');
        return { elements, complete: false };
      }
      lastCursor = newLast;
    }
  }

  const elements: any[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    await acquireCloverCatalogToken(siteId);
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (expand) q.set('expand', expand);
    const res = await client.get<{ elements?: any[] }>(`${path}?${q.toString()}`);
    const batch = res.data?.elements ?? [];
    elements.push(...batch);
    pages += 1;
    if (batch.length < PAGE) return { elements, complete: true };
    if (pages >= MAX_PAGES) {
      logger.warn({ site_id: siteId, path, fetched: elements.length }, 'clover_catalog_pagination_capped');
      return { elements, complete: false };
    }
    offset += PAGE;
  }
}

const parseAP = (v: unknown): Record<string, any> => {
  if (v == null) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return v as Record<string, any>;
};

// Guard against WIPING a live catalog when a sweep is partial/degraded (short/empty 200 page,
// or Clover's offset-cap silently returning a short page for a >1000-item catalog → false
// `complete`). Never soft-archive more than a small fraction of the mapped catalog in one sweep;
// a larger shrink is treated as a suspect fetch → skip archiving + log (no silent wipe).
export const ARCHIVE_MAX_SHRINK_RATIO = 0.15;
export const ARCHIVE_MAX_SHRINK_ABS = 10;
export function archiveIsSafe(complete: boolean, presentCount: number, existingCloverCount: number): boolean {
  if (!complete || presentCount === 0 || existingCloverCount === 0) return false;
  const wouldArchive = Math.max(0, existingCloverCount - presentCount);
  const cap = Math.max(ARCHIVE_MAX_SHRINK_ABS, Math.floor(existingCloverCount * ARCHIVE_MAX_SHRINK_RATIO));
  return wouldArchive <= cap;
}

/** Insert a catalog row; if a concurrent sweep won the (site_id, cloverId) UNIQUE race (23505),
 * adopt the existing row instead of failing — makes the check-then-insert path concurrency-safe. */
export async function insertOrAdopt(
  table: string, siteId: number, cloverId: string, row: Record<string, any>
): Promise<{ id: number; adopted: boolean }> {
  const { data: ins, error } = await supabase.from(table).insert(row).select('id').single();
  if (!error) return { id: Number((ins as any).id), adopted: false };
  if ((error as any).code === '23505') {
    const { data: dupe } = await supabase.from(table).select('id')
      .eq('site_id', siteId).contains('additional_properties', { cloverId }).limit(1).maybeSingle();
    if (dupe) return { id: Number((dupe as any).id), adopted: true };
  }
  throw error;
}

// ─────────────────────────────────────────────────────────── categories ──
export async function syncCloverCategories(
  siteId: number,
  client: AxiosInstance
): Promise<{ stats: CatalogSyncStats; cloverIdToMcmId: Map<string, number> }> {
  const stats = emptyStats();
  const cloverIdToMcmId = new Map<string, number>();

  const { elements: cats, complete } = await fetchAllCloverElements(client, siteId, '/categories');
  const present = new Set<string>();

  const { data: existing, error: readErr } = await supabase
    .from('categories')
    .select('id, name, menu_order, status, additional_properties')
    .eq('site_id', siteId);
  if (readErr) throw readErr;
  const byClover = new Map<string, any>();
  for (const row of existing ?? []) {
    const cid = parseAP((row as any).additional_properties).cloverId;
    if (cid) byClover.set(String(cid), row);
  }

  for (const cat of cats) {
    if (cat.deleted) { stats.skipped++; continue; }
    stats.total++;
    present.add(String(cat.id));
    const prev = byClover.get(String(cat.id));
    if (prev) {
      cloverIdToMcmId.set(String(cat.id), Number(prev.id));
      const ap = { ...parseAP(prev.additional_properties), cloverId: String(cat.id), cloverArchived: false };
      const changed = (prev.name ?? '') !== (cat.name ?? '') || Number(prev.menu_order) !== Number(cat.sortOrder ?? 0) || prev.status !== 'published';
      if (!changed) { stats.skipped++; continue; }
      const { error } = await supabase.from('categories')
        .update({ name: cat.name, menu_order: cat.sortOrder ?? 0, status: 'published', additional_properties: ap, date_updated: new Date().toISOString() })
        .eq('id', prev.id).eq('site_id', siteId);
      if (error) throw error;
      stats.updated++;
    } else {
      const { id, adopted } = await insertOrAdopt('categories', siteId, String(cat.id), {
        site_id: siteId, name: cat.name, description: '',
        slug: String(cat.name ?? 'category').toLowerCase().replace(/\s+/g, '-'),
        image: {}, menu_order: cat.sortOrder ?? 0, count: 0,
        additional_properties: { cloverId: String(cat.id) }, tags: [], status: 'published', translations: {},
      });
      cloverIdToMcmId.set(String(cat.id), id);
      if (adopted) stats.updated++; else stats.created++;
    }
  }

  // Soft-archive (G9) — guarded against wiping a live catalog on a partial/degraded sweep.
  if (archiveIsSafe(complete, present.size, byClover.size)) {
    for (const [cid, row] of byClover) {
      if (present.has(cid)) continue;
      const ap = parseAP(row.additional_properties);
      if (ap.cloverArchived === true) continue;
      const { error } = await supabase.from('categories')
        .update({ status: 'draft', additional_properties: { ...ap, cloverArchived: true }, date_updated: new Date().toISOString() })
        .eq('id', row.id).eq('site_id', siteId);
      if (error) throw error;
      stats.archived++;
    }
  } else if (complete && byClover.size - present.size > Math.max(ARCHIVE_MAX_SHRINK_ABS, Math.floor(byClover.size * ARCHIVE_MAX_SHRINK_RATIO))) {
    logger.warn({ site_id: siteId, existing: byClover.size, present: present.size }, 'clover_archive_skipped_suspicious_categories');
  }
  return { stats, cloverIdToMcmId };
}

// ───────────────────────────────────────────────────────────── products ──
export async function syncCloverProducts(
  siteId: number,
  items: any[],
  itemsComplete: boolean,
  categoryCloverToMcm: Map<string, number>
): Promise<{ stats: CatalogSyncStats; cloverIdToMcmId: Map<string, number> }> {
  const stats = emptyStats();
  const cloverIdToMcmId = new Map<string, number>();

  const { data: existing, error: readErr } = await supabase
    .from('products')
    .select('id, name, description, price, sku, status, stock_status, tax_class, is_taxable, categories_id, additional_properties')
    .eq('site_id', siteId);
  if (readErr) throw readErr;
  const byClover = new Map<string, any>();
  for (const row of existing ?? []) {
    const cid = parseAP((row as any).additional_properties).cloverId;
    if (cid) byClover.set(String(cid), row);
  }
  const present = new Set<string>();

  for (const item of items) {
    if (item.deleted || item.hidden) { stats.skipped++; continue; }
    stats.total++;
    present.add(String(item.id));

    const categoryIds: string[] = [];
    for (const c of item.categories?.elements ?? []) {
      const mcmId = categoryCloverToMcm.get(String(c.id));
      if (mcmId != null) categoryIds.push(String(mcmId));
    }
    const price = (Number(item.price ?? 0) / 100).toFixed(2);
    const available = item.available !== false;
    const status = available ? 'published' : 'draft';
    const stockStatus = available ? 'instock' : 'outofstock';
    let taxClass = 'standard';
    for (const t of item.taxRates?.elements ?? []) {
      if (String(t.name ?? '').toLowerCase().includes('reduced')) taxClass = 'reduced';
    }
    const prev = byClover.get(String(item.id));
    // Variable/weight-priced Clover items (priceType VARIABLE/PER_UNIT) legitimately carry price=0
    // (entered at sale) — record the type so downstream doesn't read $0 as a real fixed price.
    const priceType = item.priceType && item.priceType !== 'FIXED' ? String(item.priceType) : undefined;
    const ap: Record<string, any> = { ...(prev ? parseAP(prev.additional_properties) : {}), cloverId: String(item.id), cloverArchived: false };
    if (priceType) ap.cloverPriceType = priceType; else delete ap.cloverPriceType;
    const isTaxable = item.defaultTaxRates !== false;
    const base = {
      site_id: siteId, name: item.name, description: item.description ?? '', price,
      sku: item.sku ?? '', status, stock_status: stockStatus, tax_class: taxClass,
      is_taxable: isTaxable, categories_id: categoryIds,
      additional_properties: ap, date_updated: new Date().toISOString(),
    };

    if (prev) {
      cloverIdToMcmId.set(String(item.id), Number(prev.id));
      // Compare price as integer cents — PostgREST returns numeric as a JS number (5.5),
      // while base.price is a 2dp string ("5.50"); a string compare would falsely flag every
      // price ending in 0 cents as changed (breaks idempotency). Categories compared order-insensitively.
      const prevCents = Math.round(Number(prev.price) * 100);
      const baseCents = Math.round(Number(base.price) * 100);
      const prevCats = JSON.stringify([...(prev.categories_id ?? [])].map(String).sort());
      const baseCats = JSON.stringify([...categoryIds].sort());
      const changed =
        (prev.name ?? '') !== base.name || prevCents !== baseCents ||
        prev.status !== status || prev.stock_status !== stockStatus || prev.tax_class !== taxClass ||
        (prev.description ?? '') !== base.description || (prev.sku ?? '') !== base.sku ||
        (prev.is_taxable ?? true) !== isTaxable ||
        prevCats !== baseCats ||
        parseAP(prev.additional_properties).cloverArchived === true;
      if (!changed) { stats.skipped++; continue; }
      const { error } = await supabase.from('products').update(base).eq('id', prev.id).eq('site_id', siteId);
      if (error) throw error;
      stats.updated++;
    } else {
      const { id, adopted } = await insertOrAdopt('products', siteId, String(item.id),
        { ...base, description: item.description ?? '', images: [], ingredients: [], tags: [], variations: [], public_tags: [], translations: {}, menu_order: 0 });
      cloverIdToMcmId.set(String(item.id), id);
      if (adopted) { await supabase.from('products').update(base).eq('id', id).eq('site_id', siteId); stats.updated++; }
      else stats.created++;
    }
  }

  // Soft-archive (G9) — guarded against wiping a live catalog on a partial/degraded sweep.
  if (archiveIsSafe(itemsComplete, present.size, byClover.size)) {
    for (const [cid, row] of byClover) {
      if (present.has(cid)) continue;
      const ap = parseAP(row.additional_properties);
      if (ap.cloverArchived === true) continue;
      const { error } = await supabase.from('products')
        .update({ status: 'draft', stock_status: 'outofstock', additional_properties: { ...ap, cloverArchived: true }, date_updated: new Date().toISOString() })
        .eq('id', row.id).eq('site_id', siteId);
      if (error) throw error;
      stats.archived++;
    }
  } else if (itemsComplete && byClover.size - present.size > Math.max(ARCHIVE_MAX_SHRINK_ABS, Math.floor(byClover.size * ARCHIVE_MAX_SHRINK_RATIO))) {
    logger.warn({ site_id: siteId, existing: byClover.size, present: present.size }, 'clover_archive_skipped_suspicious_products');
  }
  return { stats, cloverIdToMcmId };
}

// ─────────────────────────────────────────── POS catalog (menu visibility) ──
/**
 * ADDITIVE, flag-gated (`config.autoManageCloverCatalog`, default OFF): maintain a
 * Clover-managed row in `catalogs` so the synced products actually render in /pos-order.
 * The POS menu (`get-menus`/`getMenusForFrontend`) only surfaces products whose category is
 * listed in a PUBLISHED catalog's `items[].categories_id` for the right channel — products in
 * the `products` table alone are invisible. This upserts ONE catalog (identified by
 * `additional_properties.cloverManaged=true`) whose single item lists every synced Clover
 * category id, channels=['pos'] (+ optional extras). Idempotent; scoped by site_id; never
 * touches human-curated catalogs (only its own `cloverManaged` row).
 */
export async function syncCloverPosCatalog(
  siteId: number,
  categoryMcmIds: number[],
  channels: string[] = ['pos']
): Promise<{ action: string; catalog_id: string | null; categories: number; uncategorized: number }> {
  // Clover items with NO category can't be reached via the catalog's categories_id — so a
  // category-only menu would drop them. Add them explicitly via the item `products_id` so
  // every synced (non-archived) product renders in /pos-order.
  const { data: prods } = await supabase
    .from('products').select('id, categories_id, additional_properties').eq('site_id', siteId);
  const uncategorizedProductIds = (prods ?? [])
    .filter((p: any) => {
      const ap = parseAP(p.additional_properties);
      if (!ap.cloverId || ap.cloverArchived === true) return false;
      const cats = p.categories_id;
      return !Array.isArray(cats) || cats.length === 0;
    })
    .map((p: any) => String(p.id));

  const item = {
    name: 'Clover', view: 'list', status: 'published', description: '',
    tags: [] as string[], products_id: uncategorizedProductIds, products_excluded_id: [] as string[],
    categories_id: categoryMcmIds.map(String), translations: { en: { name: 'Clover' } }, additional_properties: {},
  };
  const { data: existing, error: readErr } = await supabase
    .from('catalogs').select('id, additional_properties').eq('site_id', siteId);
  if (readErr) throw readErr;
  const managed = (existing ?? []).find((c: any) => parseAP(c.additional_properties).cloverManaged === true);

  if (managed) {
    const { error } = await supabase.from('catalogs')
      .update({ items: [item], channels, status: 'published', date_updated: new Date().toISOString() })
      .eq('id', (managed as any).id).eq('site_id', siteId);
    if (error) throw error;
    return { action: 'updated', catalog_id: (managed as any).id, categories: categoryMcmIds.length, uncategorized: uncategorizedProductIds.length };
  }
  const { data: ins, error } = await supabase.from('catalogs')
    .insert({ site_id: siteId, name: 'Clover (auto)', status: 'published', channels, experiences: [], items: [item], additional_properties: { cloverManaged: true } })
    .select('id').single();
  if (error) {
    // Concurrency-safe: the partial UNIQUE(site_id) WHERE cloverManaged (mig 030) makes a racing
    // second insert 23505 — adopt the existing managed catalog and update it instead of duplicating.
    if ((error as any).code === '23505') {
      const { data: rows } = await supabase.from('catalogs').select('id, additional_properties').eq('site_id', siteId);
      const m = (rows ?? []).find((c: any) => parseAP(c.additional_properties).cloverManaged === true);
      if (m) {
        await supabase.from('catalogs').update({ items: [item], channels, status: 'published', date_updated: new Date().toISOString() }).eq('id', (m as any).id).eq('site_id', siteId);
        return { action: 'adopted', catalog_id: (m as any).id, categories: categoryMcmIds.length, uncategorized: uncategorizedProductIds.length };
      }
    }
    throw error;
  }
  return { action: 'created', catalog_id: (ins as any)?.id ?? null, categories: categoryMcmIds.length, uncategorized: uncategorizedProductIds.length };
}

// ─────────────────────────────────────────── item stock / 86 (products) ──
/** Reflect Clover item `available` + item_stocks into products.stock_status/status.
 *  Matched by cloverId. Only touches products that changed. */
export async function syncCloverItemStock(
  siteId: number,
  items: any[]
): Promise<CatalogSyncStats> {
  const stats = emptyStats();
  const { data: existing, error } = await supabase
    .from('products').select('id, status, stock_status, additional_properties').eq('site_id', siteId);
  if (error) throw error;
  const byClover = new Map<string, any>();
  for (const row of existing ?? []) {
    const cid = parseAP((row as any).additional_properties).cloverId;
    if (cid) byClover.set(String(cid), row);
  }
  for (const item of items) {
    if (item.deleted) { stats.skipped++; continue; }
    const prev = byClover.get(String(item.id));
    if (!prev) { stats.skipped++; continue; }
    // Never resurrect a soft-archived product via item-stock (it's absent from the catalog by policy).
    if (parseAP(prev.additional_properties).cloverArchived === true) { stats.skipped++; continue; }
    stats.total++;
    // `hidden` also means unavailable for ordering (an item hidden in Clover must not read instock).
    const available = item.available !== false && item.hidden !== true;
    const stockStatus = available ? 'instock' : 'outofstock';
    const targetStatus = available ? (prev.status === 'draft' ? 'published' : prev.status) : 'draft';
    // Skip only when BOTH stock AND visibility already match — so a draft-but-instock row
    // (86'd then re-available) still gets republished (was previously stuck as draft).
    if (prev.stock_status === stockStatus && prev.status === targetStatus) { stats.skipped++; continue; }
    const { error: upErr } = await supabase.from('products')
      .update({ stock_status: stockStatus, status: targetStatus, date_updated: new Date().toISOString() })
      .eq('id', prev.id).eq('site_id', siteId);
    if (upErr) throw upErr;
    stats.updated++;
  }
  return stats;
}
