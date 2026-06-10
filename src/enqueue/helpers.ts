import { randomUUID } from 'crypto';
import { supabase } from '../lib/supabase';
import { HandlerError } from '../core/types';

// ── Types ────────────────────────────────────────────────────

/**
 * Pre-built injection payload (Option A: the edge function builds the exact
 * Omnivore request bodies using the legacy `omnivore-helper`, then freezes them
 * here). The handlers POST these verbatim, split across the 3 steps:
 *   - `ticket`   → POST /tickets                (items/payments omitted)
 *   - `items`    → POST /tickets/:id/items      ({ items })
 *   - `payments` → POST /tickets/:id/payments   (one POST per element)
 */
export interface PosInjectionPayload {
  order_id: string | number;
  ticket: Record<string, unknown>;
  items: unknown[];
  payments: unknown[];
  [key: string]: unknown;
}

// ── enqueueOrderInjection ────────────────────────────────────

/**
 * Enqueues a 3-step POS order injection job (create order → add items → create
 * payment). The producer (edge function) mirrors this exact step/idempotency
 * structure when calling the `enqueue_job` RPC directly. Returns the job ID.
 */
export async function enqueueOrderInjection(params: {
  siteId: number;
  orderId: string | number;
  posProvider: 'omnivore' | 'clover';
  payload: PosInjectionPayload;
  correlationId?: string;
}): Promise<string> {
  const idempotencyKey = `pos_inject:${params.posProvider}:${params.orderId}`;

  const { data, error } = await supabase.rpc('enqueue_job', {
    p_site_id: params.siteId,
    p_queue_name: 'pos_injection',
    p_job_type: 'order_injection',
    p_integration: params.posProvider,
    p_idempotency_key: idempotencyKey,
    p_payload: params.payload,
    p_total_steps: 3,
    p_steps: [
      { step_name: 'create_order',   max_attempts: 3, idempotency_key: `${idempotencyKey}:create_order` },
      { step_name: 'add_items',      max_attempts: 5, idempotency_key: `${idempotencyKey}:add_items` },
      { step_name: 'create_payment', max_attempts: 5, idempotency_key: `${idempotencyKey}:create_payment` },
    ],
    p_priority: 7,
    p_reference_type: 'order',
    p_reference_id: String(params.orderId),
    p_correlation_id: params.correlationId ?? null,
  });

  if (error) throw new HandlerError(`enqueue_job failed: ${error.message}`, 'ENQUEUE_FAILED', false);
  return data as string;
}

// ── enqueuePaymentInjection ──────────────────────────────────

/**
 * Enqueues a standalone 1-step payment injection job — applies an
 * already-completed payment to an EXISTING POS ticket. The edge producer
 * mirrors this exact structure via the `enqueue_job` RPC. Returns the job ID.
 */
export async function enqueuePaymentInjection(params: {
  siteId: number;
  paymentId: string | number;
  orderId: string | number;
  ticketId: string;
  posProvider: 'omnivore' | 'clover';
  payment: Record<string, unknown>;
  correlationId?: string;
  /**
   * Where the consumer persists the "applied" marker on the `payments` row.
   * Default `pos_id`. The Clover-pull → Omnivore forward passes
   * `additional_properties.omnivore_payment_id` (pos_id already holds the Clover
   * payment id there). See omnivore/inject/payment.ts.
   */
  posIdField?: string;
  /** Step max_attempts (default 5). */
  maxAttempts?: number;
}): Promise<string> {
  const idempotencyKey = `pos_pay:${params.posProvider}:${params.paymentId}`;

  const payload: Record<string, unknown> = {
    payment_id: params.paymentId,
    order_id: params.orderId,
    ticket_id: params.ticketId,
    payment: params.payment,
  };
  if (params.posIdField) payload.pos_id_field = params.posIdField;

  const { data, error } = await supabase.rpc('enqueue_job', {
    p_site_id: params.siteId,
    p_queue_name: 'pos_injection',
    p_job_type: 'payment_injection',
    p_integration: params.posProvider,
    p_idempotency_key: idempotencyKey,
    p_payload: payload,
    p_total_steps: 1,
    p_steps: [
      {
        step_name: 'payment_injection',
        max_attempts: params.maxAttempts ?? 5,
        idempotency_key: `${idempotencyKey}:apply`,
      },
    ],
    p_priority: 7,
    p_reference_type: 'order',
    p_reference_id: String(params.orderId),
    p_correlation_id: params.correlationId ?? null,
  });

  if (error) throw new HandlerError(`enqueue_job failed: ${error.message}`, 'ENQUEUE_FAILED', false);
  return data as string;
}

// ── enqueueCloverSupplementalInjection ───────────────────────

/**
 * Enqueues a 2-step supplemental Clover order job (create_supplemental_order →
 * reconcile_items) for items added AFTER the primary Clover order was paid (which
 * Clover won't let us mutate). Idempotency is keyed on the delta signature, so a
 * retry of the same delta adopts the existing supplement, while a later, larger
 * delta produces a new supplement. Returns the job ID.
 */
export async function enqueueCloverSupplementalInjection(params: {
  siteId: number;
  orderId: string | number;
  externalReferenceId: string;
  deltaSignature: string;
  lineItems: unknown[];
  totalCents: number;
  correlationId?: string;
}): Promise<string> {
  const idem = `clover_supp_inject:${params.orderId}:${params.deltaSignature}`;

  const orderBody: Record<string, unknown> = {
    title: `MCM #${params.orderId} (add'l)`,
    state: 'open',
    currency: 'USD',
    externalReferenceId: params.externalReferenceId,
  };
  if (params.totalCents > 0) orderBody.total = params.totalCents;

  const { data, error } = await supabase.rpc('enqueue_job', {
    p_site_id: params.siteId,
    p_queue_name: 'pos_injection',
    p_job_type: 'supplemental_order_injection',
    p_integration: 'clover',
    p_idempotency_key: idem,
    p_payload: {
      order_id: params.orderId,
      external_reference_id: params.externalReferenceId,
      delta_signature: params.deltaSignature,
      order_body: orderBody,
      line_items: params.lineItems,
      line_items_hash: params.deltaSignature,
      order_total_cents: params.totalCents,
      supplemental: true,
    },
    p_total_steps: 2,
    p_steps: [
      { step_name: 'create_supplemental_order', max_attempts: 3, idempotency_key: `${idem}:create` },
      { step_name: 'reconcile_items', max_attempts: 5, idempotency_key: `${idem}:reconcile` },
    ],
    p_priority: 7,
    p_reference_type: 'order',
    p_reference_id: String(params.orderId),
    p_correlation_id: params.correlationId ?? null,
  });

  if (error) throw new HandlerError(`enqueue_job failed: ${error.message}`, 'ENQUEUE_FAILED', false);
  return data as string;
}

// ── enqueueSms ───────────────────────────────────────────────

/**
 * Enqueues an SMS notification via Twilio.
 */
export async function enqueueSms(params: {
  siteId: number;
  to: string;
  body: string;
  reference?: { type: string; id: string };
  correlationId?: string;
}): Promise<string> {
  const idempotencyKey = `sms:${params.siteId}:${params.to}:${randomUUID()}`;

  const { data, error } = await supabase.rpc('enqueue_job', {
    p_site_id: params.siteId,
    p_queue_name: 'notifications',
    p_job_type: 'send_sms',
    p_integration: 'twilio',
    p_idempotency_key: idempotencyKey,
    p_payload: { to: params.to, body: params.body },
    p_total_steps: 1,
    p_steps: [
      { step_name: 'send_sms', max_attempts: 5, input: { to: params.to, body: params.body } },
    ],
    p_priority: 6,
    p_reference_type: params.reference?.type ?? null,
    p_reference_id: params.reference?.id ?? null,
    p_correlation_id: params.correlationId ?? null,
  });

  if (error) throw new HandlerError(`enqueue_job failed: ${error.message}`, 'ENQUEUE_FAILED', false);
  return data as string;
}

// ── enqueueEmail ─────────────────────────────────────────────

/**
 * Enqueues a transactional email via SendGrid.
 */
export async function enqueueEmail(params: {
  siteId: number;
  to: string;
  subject: string;
  html: string;
  correlationId?: string;
}): Promise<string> {
  const idempotencyKey = `email:${params.siteId}:${params.to}:${randomUUID()}`;

  const { data, error } = await supabase.rpc('enqueue_job', {
    p_site_id: params.siteId,
    p_queue_name: 'notifications',
    p_job_type: 'send_email',
    p_integration: 'sendgrid',
    p_idempotency_key: idempotencyKey,
    p_payload: { to: params.to, subject: params.subject, html: params.html },
    p_total_steps: 1,
    p_steps: [
      {
        step_name: 'send_email',
        max_attempts: 5,
        input: { to: params.to, subject: params.subject, html: params.html },
      },
    ],
    p_priority: 5,
    p_reference_type: null,
    p_reference_id: null,
    p_correlation_id: params.correlationId ?? null,
  });

  if (error) throw new HandlerError(`enqueue_job failed: ${error.message}`, 'ENQUEUE_FAILED', false);
  return data as string;
}

// ── ensureSyncSchedule ───────────────────────────────────────

/**
 * Creates a sync schedule if it doesn't exist, or returns the existing one.
 * Idempotent: safe to call on every startup.
 */
export async function ensureSyncSchedule(params: {
  siteId: number;
  integration: 'omnivore' | 'clover';
  syncType: string;
  intervalSeconds?: number;
  config: Record<string, unknown>;
}): Promise<string> {
  const { data, error } = await supabase
    .from('sync_schedules')
    .upsert(
      {
        site_id: params.siteId,
        integration: params.integration,
        sync_type: params.syncType,
        interval_seconds: params.intervalSeconds ?? 30,
        config: params.config,
        status: 'active',
      },
      { onConflict: 'site_id,integration,sync_type', ignoreDuplicates: false }
    )
    .select('id')
    .single();

  if (error) throw new HandlerError(`ensureSyncSchedule failed: ${error.message}`, 'UPSERT_FAILED', false);
  return (data as { id: string }).id;
}

// ── bulkRetryDeadLetters ─────────────────────────────────────

/**
 * Bulk-retries dead letter jobs matching the given filters.
 */
export async function bulkRetryDeadLetters(params: {
  integration?: string;
  siteId?: number;
  since?: Date;
  maxCount?: number;
}): Promise<{ count: number; jobIds: string[] }> {
  const { data, error } = await supabase.rpc('bulk_retry_dead_letters', {
    p_filters: {
      integration: params.integration ?? null,
      site_id: params.siteId ?? null,
      since: params.since?.toISOString() ?? null,
      max_count: params.maxCount ?? 100,
    },
  });

  if (error) throw new HandlerError(`bulk_retry_dead_letters failed: ${error.message}`, 'BULK_RETRY_FAILED', false);

  const result = data as { count: number; job_ids: string[] };
  return { count: result.count, jobIds: result.job_ids };
}
