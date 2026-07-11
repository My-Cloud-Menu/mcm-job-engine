import { AxiosInstance } from 'axios';
import { z } from 'zod';

// Per the Omnivore API: tables list limit is 1000, revenue_centers list limit is 50.
const TABLES_PAGE_LIMIT = 1000;
const REVENUE_CENTERS_PAGE_LIMIT = 50;

// ── Normalized shapes (flat) passed to the reconcile RPC ─────────────────────
// HAL (`_embedded`/`_links`) is parsed here in TS so the SQL stays simple. `id`
// is the stable mapping key (unique per location); `pos_id` may be non-unique and
// is kept only as reference. `seats`/`number` may be null. Each table belongs to
// exactly one revenue center (embedded).

export interface OmnivoreRevenueCenter {
  id: string;
  name: string | null;
  pos_id: string | null;
  default: boolean;
}

export interface OmnivoreTable {
  id: string;
  name: string | null;
  number: number | null;
  pos_id: string | null;
  seats: number | null;
  available: boolean | null;
  revenue_center: OmnivoreRevenueCenter | null;
}

const RevenueCenterSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  pos_id: z.string().nullable(),
  default: z.boolean(),
});

const TableSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  number: z.number().nullable(),
  pos_id: z.string().nullable(),
  seats: z.number().nullable(),
  available: z.boolean().nullable(),
  revenue_center: RevenueCenterSchema.nullable(),
});

// ── HAL helpers ──────────────────────────────────────────────────────────────

/** Omnivore ids arrive as strings; coerce defensively and treat ''/null as absent. */
function asId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length ? s : null;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRevenueCenter(raw: any): OmnivoreRevenueCenter | null {
  const id = asId(raw?.id);
  if (!id) return null;
  return RevenueCenterSchema.parse({
    id,
    name: raw?.name ?? null,
    pos_id: asId(raw?.pos_id),
    default: raw?.default === true,
  });
}

function normalizeTable(raw: any): OmnivoreTable {
  return TableSchema.parse({
    id: String(raw?.id),
    name: raw?.name ?? null,
    number: asNumber(raw?.number),
    pos_id: asId(raw?.pos_id),
    seats: asNumber(raw?.seats),
    available: typeof raw?.available === 'boolean' ? raw.available : null,
    revenue_center: normalizeRevenueCenter(raw?._embedded?.revenue_center),
  });
}

/**
 * Generic HAL list fetcher: first page via the client (baseURL =
 * .../locations/{id}); subsequent pages follow the absolute `_links.next.href`.
 * Atomic by design — any page error rejects, so a partial list never reaches the
 * reconcile (which would otherwise wrongly archive the missing tables).
 */
async function fetchHalList(
  client: AxiosInstance,
  path: string,
  embeddedKey: string,
  limit: number
): Promise<any[]> {
  const items: any[] = [];
  let nextUrl: string | null = null;
  let firstParams: Record<string, unknown> | null = { limit };
  let pages = 0;

  do {
    const res: { data: any } = nextUrl
      ? await client.get(nextUrl)
      : await client.get(path, { params: firstParams! });
    firstParams = null;

    const page = res.data?._embedded?.[embeddedKey];
    if (Array.isArray(page)) items.push(...page);

    nextUrl = res.data?._links?.next?.href ?? null;
  } while (nextUrl && ++pages < 200); // MAX_PAGES: backstop contra un _links.next malformado/cíclico

  return items;
}

/** Fetch ALL tables for the location (paginated), normalized + validated. */
export async function fetchOmnivoreTables(client: AxiosInstance): Promise<OmnivoreTable[]> {
  const raw = await fetchHalList(client, '/tables', 'tables', TABLES_PAGE_LIMIT);
  return raw.map(normalizeTable);
}

/** Fetch ALL revenue centers for the location (paginated), normalized + validated. */
export async function fetchOmnivoreRevenueCenters(
  client: AxiosInstance
): Promise<OmnivoreRevenueCenter[]> {
  const raw = await fetchHalList(client, '/revenue_centers', 'revenue_centers', REVENUE_CENTERS_PAGE_LIMIT);
  return raw.map(normalizeRevenueCenter).filter((rc): rc is OmnivoreRevenueCenter => rc !== null);
}
