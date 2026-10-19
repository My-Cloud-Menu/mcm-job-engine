import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { HandlerError } from '../../../core/types';
import messages from './injection-messages.json';

/**
 * Estado de la inyección de una orden a Omnivore, tal como lo ve el staff en Live Orders
 * (Misión Omnivore Multisucursal). Vive en `orders.pos_injection_error` (campo que ya existe): se AGREGAN claves y
 * se conservan `code`, `message` y `detail`, que ya leen las pantallas de hoy.
 *
 * - `retrying`: falló un intento y el worker lo vuelve a intentar solo.
 * - `failed`: se agotaron los intentos (o el error no se arregla reintentando). «Reintentar» lo reanuda desde el paso
 *   que falló.
 * - `needs_action`: el ticket existe pero quedó a medias (faltan ítems, falta el pago, saldo pendiente o la orden se
 *   canceló en MCM). Lo resuelve el staff en el POS.
 * - `resolved`: el staff lo resolvió a mano. El worker no vuelve a tocar la orden.
 */
export type InjectionState = 'retrying' | 'failed' | 'needs_action' | 'resolved';
export type InjectionStep = 'prepare' | 'create_order' | 'add_items' | 'create_payment';

export interface InjectionStatus {
  state: InjectionState;
  step: InjectionStep;
  code: string;
  message: string;
  detail: string | null;
  attempt: number | null;
  max_attempts: number | null;
  ticket_id: string | null;
  /** ¿Sirve el botón «Reintentar»? (en curso o resuelto: no; ticket a medias que se arregla reintentando: sí). */
  can_retry: boolean;
  at: string;
  /** Código original del POS cuando `code` es un resumen (p. ej. TICKET_WITHOUT_PAYMENT por un `pos_failure`). */
  cause_code?: string;
  /** Cuentas del ticket en el POS, en centavos (`TICKET_DUE_REMAINING`): lo que falta, lo pagado y el total. */
  amounts?: TicketAmounts;
  /** Errores crudos de Omnivore (`errors[]`), para quien los lea como antes. */
  errors?: unknown;
}

const CODES = messages.codes as Record<string, string>;
/** needs_action que SÍ se arreglan con «Reintentar» (después de corregir en el POS). */
const RETRYABLE_NEEDS_ACTION = new Set(['ITEMS_PARTIAL', 'TICKET_WITHOUT_PAYMENT']);

/** ¿Se ofrece «Reintentar»? PURA. */
export function canRetryInjection(state: InjectionState, code: string): boolean {
  if (state === 'failed') return true;
  if (state === 'needs_action') return RETRYABLE_NEEDS_ACTION.has(code);
  return false;
}
const STEPS = messages.steps as Record<InjectionStep, string>;

/** Texto corto para el staff según el código y el paso. PURA. */
export function friendlyInjectionMessage(code: string | null | undefined, step: InjectionStep): string {
  const byCode = code ? CODES[code] : undefined;
  if (byCode) return byCode;
  if (code && /^HTTP_5\d\d$/.test(code)) return CODES['HTTP_500']!;
  return STEPS[step] ?? STEPS.create_order;
}

/** Arma el estado que se guarda en la orden. PURA. */
export interface TicketAmounts {
  due: number;
  paid: number | null;
  total: number | null;
}

/** Saldo, pagado y total (pagado + saldo) del ticket, en centavos. `null` si el POS no dio el saldo. PURA. */
export function ticketAmounts(totals: { due: number | null; paid: number | null }): TicketAmounts | null {
  if (totals.due == null || !Number.isFinite(totals.due)) return null;
  const paid = totals.paid != null && Number.isFinite(totals.paid) ? totals.paid : null;
  return { due: totals.due, paid, total: paid != null ? totals.due + paid : null };
}

export function buildInjectionStatus(input: {
  state: InjectionState;
  step: InjectionStep;
  code: string;
  detail?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  ticketId?: string | null;
  responseBody?: unknown;
  causeCode?: string | null;
  amounts?: TicketAmounts | null;
  now?: Date;
}): InjectionStatus {
  const errors = (input.responseBody as { errors?: unknown } | undefined)?.errors;
  const status: InjectionStatus = {
    state: input.state,
    step: input.step,
    code: input.code,
    message: friendlyInjectionMessage(input.code, input.step),
    detail: input.detail ? String(input.detail).slice(0, 500) : null,
    attempt: input.attempt ?? null,
    max_attempts: input.maxAttempts ?? null,
    ticket_id: input.ticketId ?? null,
    can_retry: canRetryInjection(input.state, input.code),
    at: (input.now ?? new Date()).toISOString(),
  };
  if (input.causeCode && input.causeCode !== input.code) status.cause_code = input.causeCode;
  if (input.amounts) status.amounts = input.amounts;
  if (Array.isArray(errors)) status.errors = errors;
  return status;
}

/**
 * Guarda el estado en la orden (siempre con `site_id`). Nunca pisa un estado `resolved` (el staff lo resolvió a mano).
 * Nunca lanza: un fallo aquí no debe cambiar el resultado del paso.
 */
export async function persistInjectionStatus(siteId: number, orderId: unknown, status: InjectionStatus): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const { error } = await supabase
    .from('orders')
    .update({ pos_injection_error: status })
    .eq('id', orderId)
    .eq('site_id', siteId)
    .or('pos_injection_error.is.null,pos_injection_error->>state.is.null,pos_injection_error->>state.neq.resolved');
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId, code: status.code }, 'omnivore: failed to persist injection status');
  }
}

/** Limpia el estado al completar los 3 pasos (R7). No toca una orden resuelta a mano. */
export async function clearInjectionStatus(siteId: number, orderId: unknown): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const { error } = await supabase
    .from('orders')
    .update({ pos_injection_error: null })
    .eq('id', orderId)
    .eq('site_id', siteId)
    .not('pos_injection_error', 'is', null)
    .or('pos_injection_error.is.null,pos_injection_error->>state.is.null,pos_injection_error->>state.neq.resolved');
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'omnivore: failed to clear injection status');
  }
}

/** Estados de orden en los que ya no se inyecta nada nuevo (Q5). */
export const ORDER_STOP_STATUSES = new Set(['cancelled', 'trash']);

export interface OrderInjectionGuard {
  stop: 'resolved' | 'cancelled' | null;
  status: string | null;
}

/**
 * Relee la orden antes de cada paso (Q5): si se canceló en MCM o el staff la resolvió a mano, el worker no sigue.
 * PURA sobre la fila leída.
 */
export function evaluateOrderGuard(row: { status?: unknown; pos_injection_error?: unknown } | null): OrderInjectionGuard {
  const status = row?.status == null ? null : String(row.status);
  const pie = row?.pos_injection_error as { state?: unknown } | null | undefined;
  if (pie && typeof pie === 'object' && !Array.isArray(pie) && pie.state === 'resolved') {
    return { stop: 'resolved', status };
  }
  if (status && ORDER_STOP_STATUSES.has(status)) return { stop: 'cancelled', status };
  return { stop: null, status };
}

/**
 * Lee la orden (con `site_id`) y evalúa si se puede seguir. Si la lectura falla, el paso se reintenta (no se inyecta a
 * ciegas una orden que podría estar cancelada).
 */
export async function readOrderGuard(siteId: number, orderId: unknown): Promise<OrderInjectionGuard> {
  if (orderId === undefined || orderId === null) return { stop: null, status: null };
  const { data, error } = await supabase
    .from('orders')
    .select('status, pos_injection_error')
    .eq('id', orderId)
    .eq('site_id', siteId)
    .maybeSingle();
  if (error) {
    throw new HandlerError(`Order read failed: ${error.message}`, 'ORDER_READ_FAILED', true);
  }
  return evaluateOrderGuard(data as { status?: unknown; pos_injection_error?: unknown } | null);
}

/**
 * Estado a guardar cuando un paso falla: `retrying` si el worker lo vuelve a intentar, `failed` si se agotaron los
 * intentos o el error no se arregla reintentando. PURA (la regla de reintento es la misma del executor).
 */
export function statusForFailure(
  err: { code: string; message: string; retryable: boolean; responseBody?: unknown },
  step: { attempt_count: number; max_attempts: number },
  stepName: InjectionStep,
  opts: { ticketId?: string | null; now?: Date } = {}
): InjectionStatus {
  const attempt = step.attempt_count + 1;
  const terminal = !(err.retryable && attempt < step.max_attempts);
  return buildInjectionStatus({
    state: terminal ? 'failed' : 'retrying',
    step: stepName,
    code: err.code,
    detail: err.message,
    attempt,
    maxAttempts: step.max_attempts,
    ticketId: opts.ticketId ?? null,
    responseBody: err.responseBody,
    now: opts.now,
  });
}
