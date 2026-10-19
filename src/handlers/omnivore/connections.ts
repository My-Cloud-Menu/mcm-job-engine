import { supabase } from '../../lib/supabase';
import { getSiteIntegrationRows, IntegrationConfig, IntegrationRow, pickConnection } from '../../lib/credentials';
import { HandlerError } from '../../core/types';

/**
 * Conexiones Omnivore de un negocio (Misión Omnivore Multisucursal, K2).
 *
 * - Negocio de una sola conexión (todos los vivos hoy): `multi = false` y `connections` trae EXACTAMENTE la conexión de
 *   siempre (`pickConnection` sin alcance, mismos errores). Los syncs corren igual que antes.
 * - Negocio con conexiones por sucursal: `multi = true` y una conexión por sucursal ACTIVA, con su config efectiva (la
 *   del negocio con los «Ajustes propios» de la sucursal encima), ordenadas por sucursal.
 */
export interface ConnectionSet {
  multi: boolean;
  connections: IntegrationConfig[];
  /** Fila del negocio (activa, o inactiva si no hay activa), tal cual. null si no existe. */
  business: IntegrationConfig | null;
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** PURA. */
export function buildConnectionSet(rows: IntegrationRow[], siteId: number): ConnectionSet {
  const businessRow = rows.find((r) => r.location_id == null && r.active) ?? rows.find((r) => r.location_id == null) ?? null;
  const business: IntegrationConfig | null = businessRow
    ? { config: (businessRow.config ?? {}) as Record<string, unknown>, integrationId: businessRow.id, locationId: null }
    : null;
  const perLocation = rows.filter((r) => r.active && r.location_id != null);
  if (perLocation.length === 0) {
    return { multi: false, connections: [pickConnection(rows, siteId, 'omnivore')], business };
  }
  const connections = perLocation
    .map((r) => pickConnection(rows, siteId, 'omnivore', { integrationId: r.id }))
    .sort((a, b) => Number(a.locationId) - Number(b.locationId));
  return { multi: true, connections, business };
}

export async function loadOmnivoreConnections(siteId: number): Promise<ConnectionSet> {
  return buildConnectionSet(await getSiteIntegrationRows(siteId, 'omnivore', 'pos'), siteId);
}

/** Fase 2: mesas, empleados, turnos y pull de órdenes no corren en negocios con conexiones por sucursal. */
export async function isMultiLocationOmnivore(siteId: number): Promise<boolean> {
  const rows = await getSiteIntegrationRows(siteId, 'omnivore', 'pos');
  return rows.some((r) => r.active && r.location_id != null);
}

/**
 * C2 · De qué conexión se lee el catálogo (igual en todas las sucursales, C1). PURA.
 * Una conexión: esa. Varias: la sucursal elegida en la config del negocio (`catalogSourceLocationId`); si no está o no
 * tiene conexión activa, la sucursal principal del negocio; si tampoco, la primera por número de sucursal.
 */
export function catalogSourceConnection(set: ConnectionSet, defaultLocationId: string | number | null): IntegrationConfig {
  if (!set.multi) return set.connections[0]!;
  const byLocation = (loc: unknown) =>
    isEmpty(loc) ? undefined : set.connections.find((c) => String(c.locationId) === String(loc));
  return (
    byLocation(set.business?.config?.['catalogSourceLocationId']) ??
    byLocation(defaultLocationId) ??
    set.connections[0]!
  );
}

/** Sucursal principal del negocio (`locations.is_default`), siempre con `site_id`. */
export async function getDefaultLocationId(siteId: number): Promise<string | null> {
  const { data, error } = await supabase
    .from('locations')
    .select('id')
    .eq('site_id', siteId)
    .eq('is_default', true)
    .limit(1)
    .maybeSingle();
  if (error) throw new HandlerError(`Failed to read default location: ${error.message}`, 'LOCATION_LOOKUP_FAILED', true);
  return data?.id != null ? String(data.id) : null;
}

/**
 * U2 · `trigger_sync_now(…, p_integration_id)` pide una sola conexión. Devuelve las conexiones a recorrer, o lanza si el
 * id no es una conexión activa de este negocio.
 */
export function connectionsForRequest(set: ConnectionSet, integrationId: unknown): IntegrationConfig[] {
  if (isEmpty(integrationId)) return set.connections;
  const found = set.connections.filter((c) => c.integrationId === String(integrationId));
  if (found.length === 0) {
    throw new HandlerError(`Connection ${String(integrationId)} is not an active Omnivore connection of this site`, 'NO_INTEGRATION', false);
  }
  return found;
}

/** `integration_id` pedido por `trigger_sync_now` (va en el payload y en la entrada del paso). */
export function requestedIntegrationId(jobPayload: Record<string, unknown>, stepInput: Record<string, unknown>): string | null {
  const v = stepInput?.['integration_id'] ?? jobPayload?.['integration_id'];
  return isEmpty(v) ? null : String(v);
}

/** La conexión inyecta órdenes automáticamente (mismo `&&` que `shouldInjectOrderOnStatusChange` en la edge). PURA. */
export function connectionInjects(config: Record<string, unknown>): boolean {
  return !!config['sendOrderToOmnivoreInStatusChange'] && !isEmpty(config['statusChangeToTriggerOmnivoreOrder']);
}

export type PerConnectionResult<T> =
  | { connection: IntegrationConfig; ok: true; value: T }
  | { connection: IntegrationConfig; ok: false; error: unknown };

/**
 * Corre `fn` por conexión con un tope de concurrencia y un tiempo límite por conexión: una sucursal lenta o caída no
 * frena ni tumba a las demás. Nunca lanza; cada resultado dice si salió bien.
 */
export async function forEachConnection<T>(
  connections: IntegrationConfig[],
  fn: (connection: IntegrationConfig) => Promise<T>,
  opts: { concurrency?: number; timeoutMs?: number } = {}
): Promise<PerConnectionResult<T>[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const results: PerConnectionResult<T>[] = new Array(connections.length);
  let next = 0;

  const runOne = async (connection: IntegrationConfig): Promise<PerConnectionResult<T>> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        fn(connection),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new HandlerError(`Connection ${connection.integrationId} timed out after ${timeoutMs}ms`, 'CONNECTION_TIMEOUT', true)),
            timeoutMs
          );
        }),
      ]);
      return { connection, ok: true, value };
    } catch (error) {
      return { connection, ok: false, error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, connections.length) }, async () => {
    while (next < connections.length) {
      const i = next++;
      results[i] = await runOne(connections[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * C6 · El sync de agotados por sucursal (`fetch_stock`, cada 5 min) existe solo en negocios con conexiones por sucursal
 * que inyectan. Es una fila de datos en `sync_schedules` (sin cambios de esquema). Si el negocio deja de cumplirlo, se
 * desactiva. Siempre con `site_id`.
 */
export const STOCK_SYNC_INTERVAL_SECONDS = 300;

export async function ensureStockSchedule(siteId: number, wanted: boolean): Promise<void> {
  const { data, error } = await supabase
    .from('sync_schedules')
    .select('id, status')
    .eq('site_id', siteId)
    .eq('integration', 'omnivore')
    .eq('sync_type', 'fetch_stock')
    .maybeSingle();
  if (error) throw new HandlerError(`Failed to read stock schedule: ${error.message}`, 'SCHEDULE_LOOKUP_FAILED', true);

  if (wanted && (!data || data.status === 'disabled')) {
    const { error: upErr } = await supabase.from('sync_schedules').upsert(
      {
        site_id: siteId,
        integration: 'omnivore',
        sync_type: 'fetch_stock',
        interval_seconds: STOCK_SYNC_INTERVAL_SECONDS,
        status: 'active',
        next_run_at: new Date().toISOString(),
      },
      { onConflict: 'site_id,integration,sync_type' }
    );
    if (upErr) throw new HandlerError(`Failed to enable stock schedule: ${upErr.message}`, 'SCHEDULE_WRITE_FAILED', true);
  } else if (!wanted && data && data.status !== 'disabled') {
    const { error: offErr } = await supabase
      .from('sync_schedules')
      .update({ status: 'disabled', updated_at: new Date().toISOString() })
      .eq('id', data.id)
      .eq('site_id', siteId);
    if (offErr) throw new HandlerError(`Failed to disable stock schedule: ${offErr.message}`, 'SCHEDULE_WRITE_FAILED', true);
  }
}
