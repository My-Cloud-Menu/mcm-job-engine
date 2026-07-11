import { AxiosInstance } from 'axios';
import { supabase } from '../../../lib/supabase';

/**
 * N11/F20 · Omnivore → MCM CLOCK-ENTRIES (turnos) sync server-side. Reemplaza el webhook n8n sin site_id
 * (fuga cross-tenant en la location compartida). Ventana rodante (default 14 días) sobre clock_in; upsert
 * idempotente por (site_id, clock_entry_id); resuelve employee_id por (site_id, omnivore_employee_id).
 *
 * IMPORTANTE: cc_tips/net_tips/declared_tips se guardan CRUDOS (minor units nativos del POS). La unidad
 * monetaria NO está confirmada (muestras vivas = 0) → el consumidor (tab Turnos) NO muestra $ de tips.
 */

const PAGE_DELAY_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Paginated HAL fetch de /clock_entries (where=gte(clock_in,since)) siguiendo `_links.next` con cap. */
export async function fetchOmnivoreClockEntries(client: AxiosInstance, sinceUnix: number): Promise<any[]> {
  const items: any[] = [];
  let nextUrl: string | null = null;
  let pages = 0;
  do {
    const res: { data: any } = nextUrl
      ? await client.get(nextUrl)
      : await client.get(`/clock_entries?where=gte(clock_in,${sinceUnix})&limit=100`);
    const page = res.data?._embedded?.clock_entries;
    if (Array.isArray(page)) items.push(...page);
    nextUrl = res.data?._links?.next?.href ?? null;
    if (nextUrl) await sleep(PAGE_DELAY_MS);
  } while (nextUrl && ++pages < 200); // MAX_PAGES: backstop contra un _links.next malformado/cíclico
  return items;
}

const toIso = (unix: unknown): string | null =>
  typeof unix === 'number' && unix > 0 ? new Date(unix * 1000).toISOString() : null;
const toInt = (v: unknown): number | null =>
  v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v));

interface NormalizedShift {
  clock_entry_id: string;
  omnivore_employee_id: string | null;
  job_id: string | null;
  job_name: string | null;
  clock_in: string | null;
  clock_out: string | null;
  cc_tips: number | null;
  net_tips: number | null;
  declared_tips: number | null;
  minutes: number | null;
  breaks: any[];
  segments: any[];
  raw: any;
}

/** Normaliza un clock_entry crudo; null si no trae id (clave del upsert). Defensivo con el shape del POS. */
function normalizeClockEntry(ce: any): NormalizedShift | null {
  const clockEntryId = ce?.id != null ? String(ce.id) : '';
  if (!clockEntryId) return null;
  const emp = ce?._embedded?.employee;
  const job = ce?._embedded?.job ?? emp?._embedded?.job;
  const segments = ce?._embedded?.segments ?? ce?.segments ?? [];
  const breaks = ce?._embedded?.breaks ?? ce?.breaks ?? [];
  const minutes = Array.isArray(segments)
    ? segments.reduce((s: number, sg: any) => s + (Number(sg?.minutes) || 0), 0)
    : null;
  return {
    clock_entry_id: clockEntryId,
    omnivore_employee_id: emp?.id != null ? String(emp.id) : null,
    job_id: job?.id != null ? String(job.id) : null,
    job_name: job?.name ?? null,
    clock_in: toIso(ce?.clock_in),
    clock_out: toIso(ce?.clock_out),
    cc_tips: toInt(ce?.cc_tips), // CRUDO — unidad no confirmada
    net_tips: toInt(ce?.net_tips),
    declared_tips: toInt(ce?.declared_tips),
    minutes,
    breaks: Array.isArray(breaks) ? breaks : [],
    segments: Array.isArray(segments) ? segments : [],
    raw: ce,
  };
}

export interface SyncClockEntriesResult {
  total: number;
  upserted: number;
}

export async function syncOmnivoreClockEntries(params: {
  site_id: number;
  client: AxiosInstance;
  config: Record<string, unknown>;
  source?: string;
}): Promise<SyncClockEntriesResult> {
  const { site_id, client, config } = params;
  const source = params.source ?? 'scheduled';
  const windowDays = Number((config as any)?.clockEntriesWindowDays) || 14;
  const sinceUnix = Math.floor(Date.now() / 1000) - windowDays * 86400;

  const raw = await fetchOmnivoreClockEntries(client, sinceUnix);
  const normalized = raw
    .map(normalizeClockEntry)
    .filter((x): x is NormalizedShift => x !== null);
  if (normalized.length === 0) return { total: 0, upserted: 0 };

  // Resolver employee_id por (site_id, omnivore_employee_id) — best-effort, sin FK dura.
  const omniIds = [...new Set(normalized.map((n) => n.omnivore_employee_id).filter((x): x is string => !!x))];
  const empMap = new Map<string, string>();
  if (omniIds.length > 0) {
    const { data: emps } = await supabase
      .from('employees')
      .select('id, omnivore_employee_id')
      .eq('site_id', site_id)
      .in('omnivore_employee_id', omniIds);
    for (const e of emps ?? []) empMap.set(String((e as any).omnivore_employee_id), (e as any).id);
  }

  const nowIso = new Date().toISOString();
  const rows = normalized.map((n) => ({
    site_id,
    clock_entry_id: n.clock_entry_id,
    omnivore_employee_id: n.omnivore_employee_id,
    employee_id: n.omnivore_employee_id ? empMap.get(n.omnivore_employee_id) ?? null : null,
    job_id: n.job_id,
    job_name: n.job_name,
    clock_in: n.clock_in,
    clock_out: n.clock_out,
    cc_tips: n.cc_tips,
    net_tips: n.net_tips,
    declared_tips: n.declared_tips,
    minutes: n.minutes,
    breaks: n.breaks,
    segments: n.segments,
    source,
    location_id: (config as any)?.omnivoreId ?? null, // LOW: poblar la Omnivore location id para trazabilidad
    raw: n.raw,
    updated_at: nowIso,
  }));

  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('employee_shifts')
      .upsert(chunk, { onConflict: 'site_id,clock_entry_id' });
    if (error) throw error;
    upserted += chunk.length;
  }

  return { total: normalized.length, upserted };
}
