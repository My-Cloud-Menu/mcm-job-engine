import { AxiosInstance } from 'axios';
import { Job, JobStep } from '../../../core/types';
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
