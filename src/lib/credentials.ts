import { supabase } from './supabase';
import { HandlerError } from '../core/types';

interface CachedConfig {
  config: Record<string, unknown>;
  integrationId: string;
  locationId: string | null;
  expiresAt: number;
}

export interface IntegrationConfig {
  config: Record<string, unknown>;
  integrationId: string;
  /** MCM location of the connection; null = the business-level row (single-location sites). */
  locationId: string | null;
}

/**
 * Which connection to resolve (Misión Omnivore Multisucursal).
 * - `integrationId`: the exact `site_integrations` row sealed on the job when it was enqueued. Inactive rows are
 *   accepted on purpose: a job that already opened a ticket must finish against the same POS.
 * - `locationId`: the MCM location of the order. Only matters when the site has per-location rows; a site with a
 *   single business-level row (every live site today) resolves to that row exactly as before.
 */
export interface ConnectionScope {
  integrationId?: string | null;
  locationId?: string | number | null;
}

export interface IntegrationRow {
  id: string;
  config: Record<string, unknown> | null;
  active: boolean;
  location_id: string | number | null;
}

const cache = new Map<string, CachedConfig>();
const TTL_MS = 60_000;

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Config efectiva de una conexión de sucursal: la del negocio con encima los «Ajustes propios» de la sucursal.
 * Lo vacío en la sucursal se hereda. PURA.
 */
export function mergeConnectionConfig(
  business: Record<string, unknown> | null | undefined,
  location: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(business ?? {}) };
  for (const [k, v] of Object.entries(location ?? {})) {
    if (!isEmpty(v)) out[k] = v;
  }
  return out;
}

/**
 * Picks the connection row for a scope. PURA (testeable sin base). Throws HandlerError when there is no
 * unambiguous answer — never guesses another location's POS.
 */
export function pickConnection(
  rows: IntegrationRow[],
  siteId: number,
  provider: string,
  scope?: ConnectionScope
): IntegrationConfig {
  const business = rows.find((r) => r.location_id == null && r.active) ?? rows.find((r) => r.location_id == null);
  // Fila tal cual (camino de siempre).
  const raw = (row: IntegrationRow): IntegrationConfig => ({
    config: (row.config ?? {}) as Record<string, unknown>,
    integrationId: row.id,
    locationId: row.location_id == null ? null : String(row.location_id),
  });
  // Conexión de sucursal con fila del negocio: hereda su config (M2). Sin fila del negocio, tal cual.
  const effective = (row: IntegrationRow): IntegrationConfig =>
    row.location_id != null && business && business.id !== row.id
      ? { ...raw(row), config: mergeConnectionConfig(business.config, row.config) }
      : raw(row);

  if (scope?.integrationId) {
    const row = rows.find((r) => r.id === scope.integrationId);
    if (!row) {
      throw new HandlerError(
        `Integration ${scope.integrationId} not found for site ${siteId}, provider ${provider}`,
        'NO_INTEGRATION',
        false
      );
    }
    return effective(row);
  }

  const active = rows.filter((r) => r.active);
  const perLocation = active.filter((r) => r.location_id != null);

  if (scope?.locationId != null && perLocation.length > 0) {
    const row = perLocation.find((r) => String(r.location_id) === String(scope.locationId));
    if (!row) {
      throw new HandlerError(
        `No active ${provider} connection for location ${scope.locationId} (site ${siteId})`,
        'NO_INTEGRATION_FOR_LOCATION',
        false
      );
    }
    return effective(row);
  }

  // Sin sucursal (o negocio sin filas por sucursal): exactamente lo de antes con una sola fila activa.
  if (active.length === 0) {
    throw new HandlerError(
      `No active integration found for site ${siteId}, provider ${provider}`,
      'NO_INTEGRATION',
      false // Not retryable — requires customer action
    );
  }
  if (active.length === 1) return raw(active[0]!);
  const activeBusiness = active.filter((r) => r.location_id == null);
  if (activeBusiness.length === 1) return raw(activeBusiness[0]!);
  throw new HandlerError(
    `Ambiguous ${provider} connection for site ${siteId}: ${active.length} active rows and no location given`,
    'AMBIGUOUS_INTEGRATION',
    false
  );
}

/**
 * Fetch and cache the active integration config for a site+provider pair.
 * Cached for 60 seconds to avoid repeated DB lookups per job step.
 *
 * `type` narrows the lookup (e.g. 'pos') for parity with the legacy
 * `getCredentials` in mcm-edge-functions, which filters `type='pos' AND
 * provider='omnivore'` so a site can hold several integrations of the same
 * provider without colliding. Omitting `type` preserves the prior behaviour.
 *
 * `scope` (optional) resolves one connection of a multi-location site. Without it, a site with one active row gets
 * that row exactly as before.
 *
 * `opts.fresh` skips the cached read (the result is still cached for the others). La inyección lo usa: si el gerente
 * corrige la llave o una forma de pago y toca «Reintentar», el reintento no puede usar la config de hace un minuto.
 */
export async function getSiteIntegrationConfig(
  siteId: number,
  provider: string,
  type?: string,
  scope?: ConnectionScope,
  opts?: { fresh?: boolean }
): Promise<IntegrationConfig> {
  const key = `${siteId}:${provider}:${type ?? ''}:${scope?.integrationId ?? ''}:${scope?.locationId ?? ''}`;
  const cached = cache.get(key);

  if (!opts?.fresh && cached && cached.expiresAt > Date.now()) {
    return { config: cached.config, integrationId: cached.integrationId, locationId: cached.locationId };
  }

  let query = supabase
    .from('site_integrations')
    .select('id, config, active, location_id')
    .eq('site_id', siteId)
    .eq('provider', provider);

  if (type) query = query.eq('type', type);

  const { data, error } = await query;

  if (error) {
    throw new HandlerError(
      `Failed to fetch integration config: ${error.message}`,
      'INTEGRATION_LOOKUP_FAILED',
      true
    );
  }

  const resolved = pickConnection((data ?? []) as IntegrationRow[], siteId, provider, scope);

  cache.set(key, { ...resolved, expiresAt: Date.now() + TTL_MS });
  return resolved;
}

const rowsCache = new Map<string, { rows: IntegrationRow[]; expiresAt: number }>();

/**
 * Todas las filas (activas o no) de un proveedor en un negocio, siempre con `site_id` (Misión Omnivore Multisucursal):
 * los syncs de un negocio con varias sucursales recorren sus conexiones. Misma consulta y mismo TTL que
 * `getSiteIntegrationConfig`.
 */
export async function getSiteIntegrationRows(siteId: number, provider: string, type?: string): Promise<IntegrationRow[]> {
  const key = `${siteId}:${provider}:${type ?? ''}`;
  const cached = rowsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  let query = supabase
    .from('site_integrations')
    .select('id, config, active, location_id')
    .eq('site_id', siteId)
    .eq('provider', provider);
  if (type) query = query.eq('type', type);

  const { data, error } = await query;
  if (error) {
    throw new HandlerError(`Failed to fetch integration config: ${error.message}`, 'INTEGRATION_LOOKUP_FAILED', true);
  }
  const rows = (data ?? []) as IntegrationRow[];
  rowsCache.set(key, { rows, expiresAt: Date.now() + TTL_MS });
  return rows;
}

export function invalidateCredentialsCache(siteId?: number, provider?: string) {
  if (siteId !== undefined && provider !== undefined) {
    const prefix = `${siteId}:${provider}:`;
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
    for (const k of rowsCache.keys()) {
      if (k.startsWith(prefix)) rowsCache.delete(k);
    }
  } else {
    cache.clear();
    rowsCache.clear();
  }
}
