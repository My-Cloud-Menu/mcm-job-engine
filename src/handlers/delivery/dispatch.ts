import { z } from 'zod';
import { registerHandler } from '../registry';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { HandlerError } from '../../core/types';

/**
 * delivery.dispatch — despacha una orden de delivery con la robustez del job-engine
 * (retry/backoff por `delivery_dispatch`, dead-letter + alerta, circuit breaker, visibilidad).
 *
 * Reusa la edge fn `delivery-create` (quote → create → Uber / in-house, server-authoritative e
 * idempotente: una delivery por (order_id, site_id), con manejo de 23505). Este handler NO duplica
 * la lógica de Uber: solo la invoca de forma confiable.
 *
 * Disparado por:
 *   - automático: `order-notification-status-change-trigger` cuando la orden 'dl' pasa a in-kitchen.
 *   - manual: edge fn `delivery-dispatch` (POS DeliveryModal / botón "Llamar Uber").
 */

const InputSchema = z.object({
  site_id: z.number(),
  order_id: z.union([z.number(), z.string()]),
  test: z.boolean().optional(),
  provider: z.enum(['uber', 'in-house']).optional(),
  payment_type: z.enum(['prepaid', 'cod']).optional(),
});

const DISPATCH_TIMEOUT_MS = 30_000;

registerHandler('delivery', 'dispatch', async ({ jobPayload }) => {
  const input = InputSchema.parse(jobPayload);
  const url = `${config.supabase.url}/functions/v1/delivery-create`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS + 5_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
        apikey: config.supabase.serviceRoleKey,
      },
      body: JSON.stringify({
        site_id: input.site_id,
        order_id: input.order_id,
        test: input.test ?? false,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.payment_type ? { payment_type: input.payment_type } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    // red/timeout → retryable
    throw new HandlerError(
      `delivery-create network error: ${String(err?.message ?? err)}`,
      'DELIVERY_NETWORK',
      true
    );
  } finally {
    clearTimeout(timer);
  }

  const body: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 5xx/408/429 → transitorio (retryable). 4xx (400/404/409) → fatal (dead-letter).
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new HandlerError(
      `delivery-create HTTP ${res.status}: ${body?.error ?? body?.message ?? ''}`,
      `DELIVERY_HTTP_${res.status}`,
      retryable,
      res.status,
      body
    );
  }

  // delivery-create responde 2xx incluso cuando el dispatch a Uber falló (deja el registro pending
  // con dispatch_error) → tratar como retryable para que el engine reintente con backoff.
  if (body?.dispatch_error) {
    throw new HandlerError(
      `delivery dispatch_error: ${String(body.dispatch_error)}`,
      'DELIVERY_DISPATCH_ERROR',
      true,
      undefined,
      body
    );
  }

  logger.info(
    {
      site_id: input.site_id,
      order_id: input.order_id,
      delivery_id: body?.delivery?.id ?? null,
      status: body?.delivery?.status ?? null,
      idempotent: body?.idempotent ?? false,
      pending_dispatch: body?.pending_dispatch ?? false,
    },
    'delivery.dispatch done'
  );

  return {
    delivery_id: body?.delivery?.id ?? null,
    status: body?.delivery?.status ?? null,
    idempotent: body?.idempotent ?? false,
  };
});
