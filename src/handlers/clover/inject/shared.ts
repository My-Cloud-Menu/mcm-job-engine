import { classifyCloverError } from '../friendly-errors';
import { AxiosInstance } from 'axios';
import { HandlerError, Job, JobStep } from '../../../core/types';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

export function idempotencyId(step: JobStep, job: Job, stepName: string): string {
  return step.idempotency_key ?? `${job.id}:${stepName}`;
}

/**
 * Find an existing Clover order id by its deterministic `externalReferenceId`
 * (header-independent dedup/resume guard for create_order).
 */
export async function findCloverOrderIdByExternalRef(
  client: AxiosInstance,
  externalReferenceId: string
): Promise<string | null> {
  const res = await client.get<{ elements?: Array<{ id: string }> }>('/orders', {
    params: { filter: `externalReferenceId=${externalReferenceId}`, limit: 1 },
  });
  return res.data?.elements?.[0]?.id ?? null;
}

/** Persist the Clover order id (push direction) + clear any prior injection error. */
export async function persistCloverTicketId(
  siteId: number,
  orderId: unknown,
  cloverOrderId: string
): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const { error } = await supabase
    .from('orders')
    .update({ clover_ticket_id: cloverOrderId, pos_injection_error: null })
    .eq('id', orderId)
    .eq('site_id', siteId);
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover: failed to persist clover_ticket_id');
  }
}

/** Persist the synced line-items hash (so a same-hash re-run short-circuits). */
export async function persistCloverHash(siteId: number, orderId: unknown, hash: string): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const { error } = await supabase
    .from('orders')
    .update({ clover_line_items_hash: hash })
    .eq('id', orderId)
    .eq('site_id', siteId);
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover: failed to persist clover_line_items_hash');
  }
}

export async function getOrderCloverState(
  siteId: number,
  orderId: unknown
): Promise<{ clover_ticket_id: string | null; clover_line_items_hash: string | null } | null> {
  if (orderId === undefined || orderId === null) return null;
  const { data } = await supabase
    .from('orders')
    .select('clover_ticket_id, clover_line_items_hash')
    .eq('id', orderId)
    .eq('site_id', siteId)
    .maybeSingle();
  return (data as any) ?? null;
}

/** Persist a terminal injection error (provider-tagged) for /live-orders. */
export async function persistInjectionError(
  siteId: number,
  orderId: unknown,
  err: { code: string; message: string; responseBody?: unknown }
): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const body = err.responseBody as { message?: unknown } | undefined;
  const payload = { provider: 'clover', code: err.code, message: err.message, detail: body?.message ?? null };
  const { error } = await supabase
    .from('orders')
    .update({ pos_injection_error: payload })
    .eq('id', orderId)
    .eq('site_id', siteId);
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover: failed to persist pos_injection_error');
  }
}

/** Mirrors the executor's willRetry logic so a handler can persist a terminal error before throwing. */
export function willTerminate(retryable: boolean, step: JobStep): boolean {
  const attemptNumber = step.attempt_count + 1;
  return !(retryable && attemptNumber < step.max_attempts);
}

/**
 * Escribe el fallo de PAGO en `orders.issues` — la columna que sí ve el mesero.
 *
 * POR QUÉ: `orderandpay/` (la app del mesero) es el único consumidor de `orders.issues`, y le da
 * el trato que merece un pago que no entró — sube la cuenta al tope de la lista
 * (`orderAttention.ts:60`, `sortWeight: 100`), badge rojo, banner con el `friendly_error` y un
 * botón **«Reintentar»**. Clover escribía todo en `pos_injection_error`, que esa app **no lee**
 * (grep: cero), así que sus fallos de cobro eran **invisibles para quien podía arreglarlos**.
 *
 * Y de paso arregla una colisión: Clover metía sus CINCO tipos de fallo (crear orden, ítems,
 * suplementarias, reconciliar, pagar) en una sola columna, así que un pago fallido **pisaba** el
 * error de inyección de la orden. Ahora se reparte igual que Omnivore: pago → `issues`, el resto
 * → `pos_injection_error`.
 *
 * OJO CON `error`: en Omnivore esa clave guarda `JSON.stringify(responseBody)`, y se midió que
 * llega a contener el ticket ENTERO con sus `_links` — varios kilobytes por fila. Aquí se guarda
 * el mensaje y el código, no el volcado.
 */
export async function persistCloverPaymentIssue(
  siteId: number,
  orderId: unknown,
  paymentId: unknown,
  err: HandlerError,
): Promise<void> {
  if (orderId === undefined || orderId === null) return;

  // `friendly_error` es lo que se pinta delante de una persona; el mensaje crudo del handler va
  // al lado, acotado, para poder diagnosticar sin volcar la respuesta entera.
  const amable = classifyCloverError(err);

  const { error } = await supabase
    .from('orders')
    .update({
      issues: {
        provider: 'clover',
        code: err.code,
        error: String(err.message ?? '').slice(0, 500),
        friendly_error: amable.message,
        payment_id: paymentId ?? null,
      },
    })
    .eq('id', orderId)
    .eq('site_id', siteId);          // multi-tenant: SIEMPRE
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover: no se pudo escribir el issue del pago');
  }
}

/**
 * Limpia `orders.issues` cuando ESTE pago entró y ya no queda ninguno pendiente.
 *
 * Es la mitad que se olvida. `orders.issues` es un **slot único** y una orden puede tener VARIOS
 * pagos con tarjeta, cada uno con su job y todos con el mismo `reference_id`. Si se limpiara al
 * primer éxito, un segundo pago que siguiera fallando quedaría sin señal. Por eso se cuentan los
 * hermanos que NO están `completed`, excluyendo el job actual —que está `running` y a punto de
 * completar— y sólo se limpia si no queda ninguno.
 *
 * El `.not('issues','is',null)` evita un UPDATE redundante que dispararía realtime en balde.
 */
export async function reconcileCloverOrderIssues(
  siteId: number,
  orderId: unknown,
  currentJobId: string,
): Promise<void> {
  if (orderId === undefined || orderId === null) return;

  const { data: pendientes, error } = await supabase
    .from('integration_jobs')
    .select('id')
    .eq('site_id', siteId)
    .eq('integration', 'clover')
    .eq('job_type', 'payment_injection')
    .eq('reference_id', String(orderId))
    .neq('status', 'completed')
    .neq('id', currentJobId);
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'clover: no se pudieron leer los pagos hermanos');
    return;
  }
  if ((pendientes?.length ?? 0) > 0) return;   // aún queda un pago sin aplicar → se conserva el aviso

  const { error: errUpd } = await supabase
    .from('orders')
    .update({ issues: null })
    .eq('id', orderId)
    .eq('site_id', siteId)
    .not('issues', 'is', null);
  if (errUpd) {
    logger.error({ error: errUpd, site_id: siteId, order_id: orderId }, 'clover: no se pudo limpiar el issue');
  }
}
