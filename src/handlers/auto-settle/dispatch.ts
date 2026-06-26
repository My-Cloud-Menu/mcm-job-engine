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
 */

const InputSchema = z.object({
  schedule_id: z.string().uuid().optional(),
  cursor: z.string().nullable().optional(),
});

const DISPATCH_TIMEOUT_MS = 90_000;

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
    if (json?.result === 'success') return { ok: true };
    const detail = String(json?.message ?? json?.error?.errorDetails?.details ?? json?.error ?? 'dispatch_failed');
    return { ok: false, detail };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err ?? 'dispatch_error') };
  } finally {
    clearTimeout(timer);
  }
}

registerHandler('auto_settle', 'auto_settle_dispatch', async ({ stepInput, job }) => {
  const input = InputSchema.parse(stepInput ?? {});
  const siteId = job.site_id;

  // Candidatos due del site (read-only). El claim atómico decide quién cierra realmente.
  const { data: candidates, error: dueErr } = await supabase.rpc('auto_settle_due_for_site', {
    p_site_id: siteId,
  });
  if (dueErr) {
    logger.error({ err: dueErr, site_id: siteId }, 'auto_settle: due_for_site failed');
  }

  const deviceIds: string[] = ((candidates as any[]) ?? [])
    .map((r) => (typeof r === 'string' ? r : r?.device_id))
    .filter(Boolean);

  let claimed = 0;
  let settled = 0;
  let failed = 0;

  // Secuencial: pocos terminales por site; más suave con los ECR + el canal realtime.
  for (const deviceId of deviceIds) {
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
      // Visibilidad para la franja "Cierre de hoy" / alerta. El backoff ya lo aplicó el claim.
      await supabase
        .from('automatic_settlement_configuration')
        .update({ last_error: r.detail ?? 'dispatch_failed' })
        .eq('device_id', deviceId)
        .eq('site_id', siteId);
      logger.warn({ device_id: deviceId, detail: r.detail }, 'auto_settle: dispatch failed (offline/busy)');
    }
  }

  // Avanza el schedule (idempotente). Si no vino schedule_id, no-op silencioso.
  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  }

  logger.info({ site_id: siteId, candidates: deviceIds.length, claimed, settled, failed }, 'auto_settle_dispatch done');
  return { candidates: deviceIds.length, claimed, settled, failed };
});
