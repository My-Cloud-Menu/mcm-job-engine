import { AxiosInstance } from 'axios';
import { Job, JobStep } from '../../../core/types';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

/**
 * Stable per-step idempotency value sent as the Omnivore `Idempotency-Id`
 * header. Must be identical across retries of the same logical operation, which
 * is exactly what `job_steps.idempotency_key` provides (it is set at enqueue
 * time and never changes). Falls back to a deterministic value if unset.
 */
export function idempotencyId(step: JobStep, job: Job, stepName: string): string {
  return step.idempotency_key ?? `${job.id}:${stepName}`;
}

/** Escape a value for embedding inside an Omnivore RQL string literal. */
export function escapeRql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Find an OPEN ticket id by its (deterministic) name — the header-independent
 * duplicate/resume guard for step 1. Only meaningful when the name is unique
 * per order (the default `MCM {order.id}` scheme); callers must gate on that.
 */
export async function findOpenTicketIdByName(
  client: AxiosInstance,
  name: string
): Promise<string | null> {
  const res = await client.get<{ _embedded?: { tickets?: Array<{ id: string }> } }>('/tickets', {
    params: {
      where: `and(eq(open,true),eq(name,'${escapeRql(name)}'))`,
      fields: 'id',
      limit: 1,
    },
  });
  return res.data?._embedded?.tickets?.[0]?.id ?? null;
}

/**
 * Fallback Aloha-safe del adopt-by-name: algunos POS (Aloha, probado en vivo) RECHAZAN
 * `where=eq(name,...)` con `bad_query` → `findOpenTicketIdByName` siempre devuelve null ahí.
 * Este scan trae los tickets ABIERTOS y matchea el nombre EXACTO en memoria. Más caro (lista),
 * por eso el caller lo usa solo en REINTENTOS (cuando un intento previo pudo crear el ticket).
 */
export async function findOpenTicketIdByNameScan(
  client: AxiosInstance,
  name: string,
  limit = 100
): Promise<string | null> {
  const res = await client.get<{ _embedded?: { tickets?: Array<{ id: string; name?: string }> } }>('/tickets', {
    params: { where: 'eq(open,true)', fields: 'id,name', limit },
  });
  const tickets = res.data?._embedded?.tickets ?? [];
  const match = tickets.find((t) => String(t?.name ?? '') === name);
  return match?.id != null ? String(match.id) : null;
}

/** Number of items currently on a ticket — used to make `add_items` idempotent. */
export async function getTicketItemCount(client: AxiosInstance, ticketId: string): Promise<number> {
  const res = await client.get<{ _embedded?: { items?: unknown[] } }>(`/tickets/${ticketId}`, {
    params: { fields: 'items(id)' },
  });
  return res.data?._embedded?.items?.length ?? 0;
}

export interface TicketTotals {
  due: number | null;
  paid: number | null;
  paymentCount: number;
}

/** Ticket balance/payment snapshot — used to make `create_payment` idempotent. */
export async function getTicketTotals(client: AxiosInstance, ticketId: string): Promise<TicketTotals> {
  const res = await client.get<{
    totals?: { due?: number; paid?: number };
    _embedded?: { payments?: unknown[] };
  }>(`/tickets/${ticketId}`, { params: { fields: 'totals(due,paid),payments(id)' } });
  return {
    due: res.data?.totals?.due ?? null,
    paid: res.data?.totals?.paid ?? null,
    paymentCount: res.data?._embedded?.payments?.length ?? 0,
  };
}

/**
 * Persist the Omnivore ticket id onto the MCM order and clear any prior
 * injection error. Mirrors the legacy `handleSendOrderAllInOneToOmnivore`
 * post-success write (omnivore-helper.ts:1305-1310).
 */
export async function persistOmnivoreTicketId(
  siteId: number,
  orderId: unknown,
  ticketId: string
): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const { error } = await supabase
    .from('orders')
    .update({
      pos_id: ticketId,
      omnivore_pos_id: ticketId,
      global_pos_id: `${siteId}-${ticketId}`,
      pos_injection_error: null,
    })
    .eq('id', orderId)
    .eq('site_id', siteId);
  if (error) {
    logger.error(
      { error, site_id: siteId, order_id: orderId, ticket_id: ticketId },
      'omnivore: failed to persist omnivore_pos_id'
    );
  }
}

/**
 * Persist an injection error onto the MCM order, for surfacing on /live-orders.
 * Stores the Omnivore `errors` array when present (legacy shape), else a
 * compact `{ code, message }`. Called only when a step is about to dead-letter.
 */
export async function persistInjectionError(
  siteId: number,
  orderId: unknown,
  err: { code: string; message: string; responseBody?: unknown }
): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const body = err.responseBody as { errors?: unknown } | undefined;
  const payload = body?.errors ?? { code: err.code, message: err.message };
  const { error } = await supabase
    .from('orders')
    .update({ pos_injection_error: payload })
    .eq('id', orderId)
    .eq('site_id', siteId);
  if (error) {
    logger.error(
      { error, site_id: siteId, order_id: orderId },
      'omnivore: failed to persist pos_injection_error'
    );
  }
}

/**
 * Persist a payment-injection error onto the MCM order's `issues` column.
 * Mirrors the legacy `sendPaymentToOmnivore` failure write (omnivore-helper.ts).
 * Called only when the step is about to dead-letter.
 */
export async function persistPaymentIssue(
  siteId: number,
  orderId: unknown,
  paymentId: unknown,
  err: { message: string; responseBody?: unknown }
): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const { error } = await supabase
    .from('orders')
    .update({
      issues: {
        error: JSON.stringify(err.responseBody ?? err.message),
        friendly_error: err.message,
        payment_id: paymentId ?? null,
      },
    })
    .eq('id', orderId)
    .eq('site_id', siteId);
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'omnivore: failed to persist payment issue');
  }
}

/**
 * Reconcilia `orders.issues` tras aplicar OK un pago a Omnivore.
 *
 * `orders.issues` es un slot único y una orden puede tener VARIOS pagos-tarjeta
 * (cada uno con su job `payment_injection`, todos con `reference_id = order_id`).
 * Solo limpiamos el flag cuando ESTE éxito deja a TODOS los pagos de la orden
 * aplicados: contamos los hermanos `payment_injection` (omnivore) de la orden que
 * NO estén `completed`, excluyendo el job actual (que está `running` y a punto de
 * completar). Si queda alguno en dead-letter/curso, NO limpiamos — el flag sigue
 * reflejando una sincronización pendiente y se limpiará cuando complete el último.
 */
export async function reconcileOrderIssues(
  siteId: number,
  orderId: unknown,
  currentJobId: string
): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const { data: pending, error } = await supabase
    .from('integration_jobs')
    .select('id')
    .eq('site_id', siteId)
    .eq('integration', 'omnivore')
    .eq('job_type', 'payment_injection')
    .eq('reference_id', String(orderId))
    .neq('status', 'completed')
    .neq('id', currentJobId);
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'omnivore: failed to scan sibling payment jobs');
    return;
  }
  if ((pending?.length ?? 0) > 0) return; // aún hay pagos sin aplicar → conservar el flag

  const { error: updErr } = await supabase
    .from('orders')
    .update({ issues: null })
    .eq('id', orderId)
    .eq('site_id', siteId)
    .not('issues', 'is', null);
  if (updErr) {
    logger.error({ error: updErr, site_id: siteId, order_id: orderId }, 'omnivore: failed to clear order issues');
  }
}

/**
 * Whether a failed step (given its classified error) will terminate the job
 * (dead-letter) rather than retry. Mirrors the executor's `willRetry` logic so
 * a handler can persist the terminal error before throwing.
 */
export function willTerminate(retryable: boolean, step: JobStep): boolean {
  const attemptNumber = step.attempt_count + 1;
  return !(retryable && attemptNumber < step.max_attempts);
}
