import { z } from 'zod';
import { registerHandler } from '../../registry';
import { IntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { sanitizeOmnivoreHealth } from './health-mapper';
import {
  connectionInjects,
  connectionsForRequest,
  ensureStockSchedule,
  forEachConnection,
  loadOmnivoreConnections,
  requestedIntegrationId,
} from '../connections';

// schedule_id nullable: un "sync now" manual puede correr antes de que exista la fila de schedule.
const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
  integration_id: z.string().uuid().nullable().optional(),
});

const HEALTH_TIMEOUT_MS = 30_000;

/**
 * ¿La conexión puede recibir órdenes? Misma regla OPERATIVA que el dashboard (N13, `derivePosState`): POS en línea, tickets
 * no caídos y órdenes no rechazadas. `overall_healthy` (salud del AGENTE de Aloha: CPU/memoria) NO cuenta: Aloha lo reporta
 * `false` estando en línea e inyectando. PURA.
 */
export function isOperational(s: Record<string, unknown>): boolean {
  return s['pos_status'] === 'online' && s['tickets_status'] !== 'down' && s['ordering_healthy'] !== false && !s['error'];
}

/**
 * Resumen del negocio en `pos_health` con varias sucursales (A14), leído por la tarjeta del inicio con `derivePosState`:
 * todas bien → en línea; algunas → en línea pero degradado (`ordering_healthy: false`); ninguna → fuera de línea. PURA.
 */
export function multiHealthSummary(snapshots: Record<string, unknown>[]): { unhealthy: number; fields: Record<string, unknown> } {
  const unhealthy = snapshots.filter((s) => !isOperational(s)).length;
  const total = snapshots.length;
  const allDown = total > 0 && unhealthy === total;
  return {
    unhealthy,
    fields: {
      pos_status: allDown ? 'offline' : 'online',
      tickets_status: unhealthy === 0 ? 'functional' : null,
      ordering_healthy: unhealthy === 0 ? true : allDown ? null : false,
      overall_healthy: unhealthy === 0,
      error: unhealthy === 0 ? null : `${unhealthy} de ${total} sucursales con problemas`,
    },
  };
}

const errorRow = (omnivoreId: unknown, err: any): Record<string, unknown> => ({
  location_id: omnivoreId ?? null, pos_status: null, pos_type: null, agent_version: null,
  overall_healthy: false, agent_healthy: null, agent_cpu: null, agent_memory: null, agent_processes: null,
  system_healthy: null, system_cpu: null, system_memory: null, tickets_status: null, tickets_response_time: null,
  ordering_healthy: null, error: String(err?.message ?? err).slice(0, 500),
});

/** Fila de `pos_connection_health` (K4) a partir del snapshot sanitizado de una conexión. */
function connectionHealthRow(siteId: number, conn: IntegrationConfig, row: Record<string, unknown>, source: string, nowIso: string) {
  const { location_id: posLocationRef, ...rest } = row;
  return {
    integration_id: conn.integrationId,
    site_id: siteId,
    location_id: conn.locationId != null ? Number(conn.locationId) : null,
    provider: 'omnivore',
    pos_location_ref: posLocationRef ?? (conn.config['omnivoreId'] as string | undefined) ?? null,
    ...rest,
    source,
    checked_at: nowIso,
    updated_at: nowIso,
  };
}

/** Lee la salud de UNA conexión. Nunca lanza: cualquier fallo (también config incompleta) queda como fila con error. */
async function readConnectionHealth(conn: IntegrationConfig, correlationId: string): Promise<Record<string, unknown>> {
  try {
    const client = createOmnivoreClient(OmnivoreConfigSchema.parse(conn.config), correlationId);
    const { data } = await client.get('/');
    return { ...sanitizeOmnivoreHealth(data), error: null };
  } catch (err) {
    return errorRow(conn.config['omnivoreId'], err);
  }
}

/**
 * F4/F2 · Poll ÚNICO de salud del POS Omnivore por site (1/site, no N por-viewer). Escribe un snapshot
 * SANITIZADO (sin apiKey) en pos_health; los viewers del dashboard leen esa tabla bajo RLS. Fail-open:
 * si el GET falla, upsert con error + overall_healthy=false (non-fatal, no dead-letterea).
 * Scheduled via sync_schedules (integration='omnivore', sync_type='fetch_health', 120s) o on-demand.
 *
 * Misión Omnivore Multisucursal (K2 + K4):
 * - Una conexión (todos los vivos): exactamente lo de antes en `pos_health`, y además su fila en
 *   `pos_connection_health` (si esa escritura falla solo se registra; no cambia el resultado).
 * - Varias sucursales: cada conexión en paralelo (8, 30 s cada una) → una fila por conexión; `pos_health` queda como
 *   resumen del negocio (sano solo si todas lo están). Además mantiene el sync de agotados por sucursal (C6).
 * - Con `integration_id` (U2): solo esa conexión.
 */
registerHandler('omnivore', 'fetch_health', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;
  const source = isManual ? 'manual' : 'scheduled';

  const set = await loadOmnivoreConnections(job.site_id);

  if (!set.multi) {
    const conn = set.connections[0]!;
    const omnivoreConfig = OmnivoreConfigSchema.parse(conn.config);
    const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);

    let row: Record<string, unknown>;
    try {
      const { data } = await client.get('/'); // baseURL = /1.0/locations/{id}
      row = { ...sanitizeOmnivoreHealth(data), error: null };
    } catch (err: any) {
      row = errorRow(omnivoreConfig.omnivoreId, err);
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabase.from('pos_health').upsert(
      { site_id: job.site_id, provider: 'omnivore', source, checked_at: nowIso, updated_at: nowIso, ...row },
      { onConflict: 'site_id' });
    if (error) throw new Error(`pos_health upsert failed: ${error.message}`);

    const { error: connErr } = await supabase
      .from('pos_connection_health')
      .upsert(connectionHealthRow(job.site_id, conn, row, source, nowIso), { onConflict: 'integration_id' });
    if (connErr) logger.warn({ site_id: job.site_id, err: connErr.message }, 'pos_connection_health upsert failed (non-fatal)');

    logger.info({ site_id: job.site_id, overall_healthy: row.overall_healthy }, 'omnivore fetch_health completed');

    if (input.schedule_id) {
      await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    }
    return { overall_healthy: row.overall_healthy };
  }

  const onlyId = requestedIntegrationId(jobPayload as Record<string, unknown>, stepInput as Record<string, unknown>);
  const targets = connectionsForRequest(set, onlyId);
  const results = await forEachConnection(targets, (c) => readConnectionHealth(c, job.correlation_id), {
    concurrency: 8,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });

  const nowIso = new Date().toISOString();
  const snapshots = results.map((r) => (r.ok ? r.value : errorRow(r.connection.config['omnivoreId'], r.error)));
  const rows = results.map((r, i) => connectionHealthRow(job.site_id, r.connection, snapshots[i]!, source, nowIso));
  const { error: connErr } = await supabase.from('pos_connection_health').upsert(rows, { onConflict: 'integration_id' });
  if (connErr) throw new Error(`pos_connection_health upsert failed: ${connErr.message}`);

  const { unhealthy, fields: summary } = multiHealthSummary(snapshots);

  if (!onlyId) {
    // Resumen del negocio en `pos_health` (una fila por negocio): sano solo si todas las conexiones lo están.
    const { error } = await supabase.from('pos_health').upsert(
      {
        site_id: job.site_id, provider: 'omnivore', source, checked_at: nowIso, updated_at: nowIso,
        ...errorRow(null, ''),
        ...summary,
      },
      { onConflict: 'site_id' });
    if (error) throw new Error(`pos_health upsert failed: ${error.message}`);

    await ensureStockSchedule(job.site_id, set.connections.some((c) => connectionInjects(c.config)));
  }

  logger.info(
    { site_id: job.site_id, connections: rows.length, unhealthy, only: onlyId },
    'omnivore fetch_health completed (multi-location)'
  );

  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }
  return { overall_healthy: unhealthy === 0, connections: rows.length, unhealthy };
});
