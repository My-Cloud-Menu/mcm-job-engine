import { z } from 'zod';
import { registerHandler } from '../../registry';
import { config } from '../../../config';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { HandlerError } from '../../../core/types';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  cursor: z.string().nullable().optional(),
  manual: z.boolean().optional(),
});

// The edge sweep may build several payloads + enqueue jobs; cap the wait so a
// hung edge invocation can't pin the job for the whole lock duration.
const EDGE_TIMEOUT_MS = 120_000;

/**
 * Recurring MCM → Clover order push (catch-up sweep). Delegates to the deployed
 * edge function `sync-orders-to-clover`, which sweeps the site's pending orders
 * (getOrdersPendingSyncToClover) and enqueues an idempotent pos_injection job per
 * order (enqueueCloverInjectionsForSite). Payload building stays in the edge
 * (Option A: edge builds, engine delivers) so there's nothing to duplicate here.
 * Idempotent end to end: `clover_inject:${order.id}:${hash}` + enqueue_job ON
 * CONFLICT means re-sweeping unchanged orders is a no-op.
 */
registerHandler('clover', 'push_orders', async ({ stepInput, job }) => {
  const input = InputSchema.parse(stepInput ?? {});

  const url = `${config.supabase.url}/functions/v1/sync-orders-to-clover`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
        apikey: config.supabase.serviceRoleKey,
      },
      body: JSON.stringify({ site_id: job.site_id }),
      signal: AbortSignal.timeout(EDGE_TIMEOUT_MS),
    });
  } catch (err) {
    // Network/timeout reaching the edge → retryable.
    throw new HandlerError(
      `clover push_orders: edge fetch failed: ${(err as Error)?.message ?? String(err)}`,
      'CLOVER_PUSH_EDGE_UNREACHABLE',
      true,
    );
  }

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  // Un 404 de "no hay integración activa" NO es un fallo: es que alguien apagó la integración.
  // Tratarlo como error permanente mandaba el job a `dead_letter` y dejaba el schedule sumando
  // `consecutive_failures` hasta `failing`, con su alerta. Se completa el schedule y se sale
  // limpio. Un 404 por OTRA causa (ruta mal) sí se sigue tratando como error.
  if (res.status === 404 && /no active .*integration/i.test(String(body?.error ?? text ?? ''))) {
    if (input.schedule_id) {
      await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    }
    return { enqueued: 0, skipped_reason: 'clover_integration_inactive' };
  }

  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    throw new HandlerError(
      `clover push_orders: edge returned ${res.status}: ${body?.error ?? text}`,
      'CLOVER_PUSH_FAILED',
      retryable,
      res.status,
      body,
    );
  }

  const enqueued = Number(body?.enqueued ?? 0);

  // Mark the schedule healthy (reset failures). Recurring runs carry a
  // schedule_id; manual "Probar ahora" may not have a schedule row.
  if (input.schedule_id) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id });
  }

  logger.info(
    { site_id: job.site_id, enqueued, manual: input.manual ?? false },
    'clover push_orders completed',
  );

  return { enqueued };
});
