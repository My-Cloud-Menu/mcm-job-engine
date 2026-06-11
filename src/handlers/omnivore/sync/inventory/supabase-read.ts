import { supabase } from '../../../../lib/supabase';

/**
 * Read ALL rows of a table for a site, paginating in 1000-row pages.
 * Replaces the legacy hardcoded `.limit(1000)/.limit(3000)` reads (which silently
 * dropped rows past the cap → duplicates + broken omnivoreId ref-mapping).
 */
export async function readAllBySite<T = any>(
  table: string,
  siteId: number | string,
  columns = '*'
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('site_id', siteId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/**
 * Next free bigint id for a site on a table whose `id` is a plain bigint (products,
 * ingredients, ingredients_groups). Use as `base + i` while inserting a batch.
 * (categories.id is an identity column → omit it, let Postgres generate.)
 */
export async function nextIdBase(table: string, siteId: number | string): Promise<number> {
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('site_id', siteId)
    .order('id', { ascending: false })
    .limit(1);
  if (error) throw error;
  const maxId = (data?.[0] as { id?: number | string } | undefined)?.id;
  const n = typeof maxId === 'number' ? maxId : Number(maxId);
  return (Number.isFinite(n) ? n : 9999) + 1;
}
