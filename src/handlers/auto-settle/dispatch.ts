import { z } from 'zod';
import { registerHandler } from '../registry';
import { supabase } from '../../lib/supabase';
import { config } from '../../config';
import { logger } from '../../lib/logger';

/**
 * F2-B · auto_settle_dispatch — PUSH del cierre automático (acelerador). El scheduler
 * (`claim_due_schedules`) lo enqueue cada ~10 min por site desde `sync_schedules`
 * (integration='auto_settle'). Para cada terminal del site que está DUE:
 *   1) `auto_settle_claim_due` (claim ATÓMICO; estampa last_try_at = backoff). Esto coordina con el
 *      PULL del heartbeat: quien estampa primero gana, el otro ve el backoff → nunca doble cierre.
 *   2) si lo reclamó → dispara `makeSettle` al device vía la edge `send-device-command` (realtime
 *      probado en Deno; el device corre el MISMO `runSettle` endurecido y reporta a `record-settlement`,
 *      que avanza el schedule). Offline/BUSY → falla suave; el PULL lo recupera al reconectar.
 *
 * Decisión de diseño (prod-safe): se reusa la edge `send-device-command` (realtime Deno ya probado en
 * producción para F66) en vez de abrir el canal realtime desde Node — evita introducir WebSocket no
 * probado en el engine. El "online" se resuelve implícitamente: offline → timeout → backoff.
 *
 * --- 2026-08-01 · el push dejó de estrangular al pull ---------------------------------------------
 * El claim es COMPARTIDO con el heartbeat y bloquea 10 min. Reclamar antes de saber si el terminal
 * responde hacía que un push roto se comiera el turno del pull, que es la vía que de verdad cierra los
 * lotes en locales cuyos terminales están apagados a la hora programada. Caso real (site 51021421):
 * el push reclamó los 6 terminales a las 17:34:37Z y el único que se encendió en todo el día mandó su
 * heartbeat a las 17:35:12Z — 35 s después — y se lo negaron. Tres cambios:
 *   • no se despacha (ni se reclama) a terminales cuyo `op_last_seen_at` está viejo → el pull queda
 *     libre para reclamar en cuanto el terminal encienda;
 *   • si el dispatch falla, se LIBERA el claim (`last_try_at = null`) en vez de dejar 10 min de veto;
 *   • `last_error` pasa a llevar un estado clasificado, no el string crudo del backend.
 */

const InputSchema = z.object({
  schedule_id: z.string().uuid().optional(),
  cursor: z.string().nullable().optional(),
});

const DISPATCH_TIMEOUT_MS = 90_000;

/**
 * Estados informativos que este barrido escribe en `automatic_settlement_configuration.last_error`.
 * Contrato acoplado con el dashboard (`components/devices/auto-settle-config.tsx`), que los traduce a
 * lenguaje humano en vez de volcar el string crudo.
 */
export const SETTLE_STATE_OFFLINE = 'device_offline';
export const SETTLE_STATE_OVERDUE = 'overdue_not_settled';

/**
 * Barridos con el terminal EN LÍNEA y el lote todavía sin cerrar antes de marcar `overdue_not_settled`.
 * Sirve para hacer visible el fallo SILENCIOSO del pull: si `runSettle` devuelve BUSY/ERROR, el device
 * descarta el resultado (`RealTimeIntegration.tsx` → `.catch(() => {})`) y no reporta nada, así que sin
 * esto el panel muestra "Programado correctamente" mientras el terminal lleva N cierres fallidos.
 */
export const OVERDUE_AFTER_ATTEMPTS = 3;

type ConfigRow = { device_id: string; last_error: string | null; attempt_count: number | null };

/**
 * Parte los candidatos en "el terminal dio señales hace poco" vs "lleva horas/días apagado", según
 * `devices.op_last_seen_at` (lo escriben SOLO `op-device-heartbeat`, cada 60 s, y `op-device-bootstrap`).
 * Sin fecha → stale: nunca se ha visto, no hay a quién empujarle nada.
 */
export function partitionByFreshness(
  deviceIds: string[],
  lastSeenById: Record<string, string | null | undefined>,
  nowMs: number,
  windowMin: number,
): { fresh: string[]; stale: string[] } {
  const windowMs = windowMin * 60_000;
  const fresh: string[] = [];
  const stale: string[] = [];
  for (const id of deviceIds) {
    const seen = lastSeenById[id];
    const seenMs = seen ? Date.parse(seen) : NaN;
    if (Number.isFinite(seenMs) && nowMs - seenMs <= windowMs) fresh.push(id);
    else stale.push(id);
  }
  return { fresh, stale };
}

async function dispatchMakeSettle(deviceId: string): Promise<{ ok: boolean; detail?: string }> {
  const url = `${config.supabase.url}/functions/v1/send-device-command`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS + 5_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
        apikey: config.supabase.serviceRoleKey,
      },
      body: JSON.stringify({
        device_id: deviceId,
        action: 'makeSettle',
        payload: { source: 'auto' }, // → triggered_by="auto" en el device
        timeout: DISPATCH_TIMEOUT_MS,
      }),
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => ({}));
    // La edge resuelve con el ack del device en éxito; en error/timeout devuelve { error, message }.
    if (res.ok && json?.result === 'success') return { ok: true };
    const detail = String(json?.message ?? json?.error?.errorDetails?.details ?? json?.error ?? 'dispatch_failed');
    // Un fallo de INFRAESTRUCTURA no puede disfrazarse de "el terminal no contestó": la edge
    // `send-device-command` estuvo sin desplegar meses y su 404 ("Requested function was not found")
    // se mostraba en el panel como si fuera problema del terminal.
    return { ok: false, detail: res.ok ? detail : `http_${res.status}: ${detail}` };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err ?? 'dispatch_error') };
  } finally {
    clearTimeout(timer);
  }
}

registerHandler('auto_settle', 'auto_settle_dispatch', async ({ stepInput, job }) => {
  const input = InputSchema.parse(stepInput ?? {});
  const siteId = job.site_id;

  /** Escribe `last_error` SOLO si cambió: un write por cambio de estado, no uno por barrido. */
  const setState = async (deviceId: string, next: string | null, current: string | null, extra?: Record<string, unknown>) => {
    if (next === current && !extra) return;
    const { error } = await supabase
      .from('automatic_settlement_configuration')
      .update({ last_error: next, ...(extra ?? {}) })
      .eq('device_id', deviceId)
      .eq('site_id', siteId); // multi-tenant explícito además de la RLS
    if (error) logger.error({ err: error, device_id: deviceId }, 'auto_settle: no se pudo escribir last_error');
  };

  // Candidatos due del site (read-only). El claim atómico decide quién cierra realmente.
  const { data: candidates, error: dueErr } = await supabase.rpc('auto_settle_due_for_site', {
    p_site_id: siteId,
  });
  // Antes se logueaba y se seguía con lista vacía → el step reportaba `candidates:0`, indistinguible de
  // "no había nada que hacer". Ahora falla ruidosamente.
  if (dueErr) throw new Error(`auto_settle_due_for_site failed: ${dueErr.message ?? dueErr}`);

  const deviceIds: string[] = ((candidates as any[]) ?? [])
    .map((r) => (typeof r === 'string' ? r : r?.device_id))
    .filter(Boolean);

  if (deviceIds.length === 0) {
    if (input.schedule_id) {
      await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    }
    return { candidates: 0, claimed: 0, settled: 0, failed: 0, skipped_offline: 0 };
  }

  // ¿Cuáles de esos terminales dieron señales de vida hace poco? Empujarle un comando realtime a uno
  // apagado solo consume su turno (y, con la edge desplegada, 90 s de timeout cada uno).
  const { data: deviceRows, error: devErr } = await supabase
    .from('devices')
    .select('id, op_last_seen_at')
    .eq('site_id', siteId)
    .in('id', deviceIds);
  if (devErr) throw new Error(`devices lookup failed: ${devErr.message ?? devErr}`);

  const lastSeenById: Record<string, string | null> = {};
  for (const d of (deviceRows as any[]) ?? []) lastSeenById[d.id] = d.op_last_seen_at ?? null;

  const { fresh, stale } = partitionByFreshness(
    deviceIds,
    lastSeenById,
    Date.now(),
    config.autoSettle.onlineWindowMin,
  );

  // Estado actual de la config, para no reescribir `last_error` en cada barrido y para saber cuántos
  // intentos lleva acumulados cada terminal.
  const { data: cfgRows, error: cfgErr } = await supabase
    .from('automatic_settlement_configuration')
    .select('device_id, last_error, attempt_count')
    .eq('site_id', siteId)
    .in('device_id', deviceIds);
  if (cfgErr) logger.error({ err: cfgErr, site_id: siteId }, 'auto_settle: no se pudo leer la config');
  const cfgById: Record<string, ConfigRow> = {};
  for (const c of (cfgRows as any[]) ?? []) cfgById[c.device_id] = c as ConfigRow;

  // Terminal apagado: NO se reclama (ni `last_try_at`, ni `attempt_count`, ni intento fallido). El
  // heartbeat gana el claim en cuanto encienda y cierra el lote antes del servicio.
  for (const deviceId of stale) {
    await setState(deviceId, SETTLE_STATE_OFFLINE, cfgById[deviceId]?.last_error ?? null);
  }

  let claimed = 0;
  let settled = 0;
  let failed = 0;

  // Secuencial: pocos terminales por site; más suave con los ECR + el canal realtime.
  for (const deviceId of fresh) {
    const cfg = cfgById[deviceId];
    const current = cfg?.last_error ?? null;

    // En línea, vencido y ya lleva varios turnos sin cerrar → algo va mal aunque nadie haya reportado
    // un error (el fallo del pull es silencioso). Se marca ANTES de intentar; si el dispatch devuelve
    // una causa concreta, la pisa más abajo.
    if ((cfg?.attempt_count ?? 0) >= OVERDUE_AFTER_ATTEMPTS) {
      await setState(deviceId, SETTLE_STATE_OVERDUE, current);
    }

    const { data: didClaim, error: claimErr } = await supabase.rpc('auto_settle_claim_due', {
      p_device_id: deviceId,
      p_site_id: siteId,
    });
    if (claimErr) {
      logger.error({ err: claimErr, device_id: deviceId }, 'auto_settle: claim_due failed');
      continue;
    }
    if (didClaim !== true) continue; // lo tomó el pull (heartbeat) o backoff activo
    claimed++;

    const r = await dispatchMakeSettle(deviceId);
    if (r.ok) {
      settled++; // el device reportó → record-settlement avanzó el schedule
    } else {
      failed++;
      // Se libera el claim: un push fallido NO puede vetar al pull durante 10 min. La cadencia del
      // push no cambia (su schedule sigue siendo de 10 min), pero el terminal puede reclamar en su
      // próximo heartbeat. Sin riesgo de doble cierre: `runSettle` tiene guard de re-entrancy y el
      // terminal responde NO TRANSACTIONS si el lote ya se cerró.
      await setState(deviceId, r.detail ?? 'dispatch_failed', current, { last_try_at: null });
      logger.warn({ device_id: deviceId, detail: r.detail }, 'auto_settle: dispatch failed (offline/busy)');
    }
  }

  // Avanza el schedule (idempotente). Si no vino schedule_id, no-op silencioso.
  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }

  logger.info(
    { site_id: siteId, candidates: deviceIds.length, claimed, settled, failed, skipped_offline: stale.length },
    'auto_settle_dispatch done',
  );
  return { candidates: deviceIds.length, claimed, settled, failed, skipped_offline: stale.length };
});
