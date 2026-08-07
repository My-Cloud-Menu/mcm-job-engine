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
  // Robustez multi-tenant: la llave lleva `site_id`. `orders.id` NO es global (PK compuesta
  // `(id, site_id)`) e `integration_jobs.idempotency_key` es UNIQUE GLOBAL → sin el site, un
  // `order.id` que ya exista en otro tenant hace que `enqueue_job` (ON CONFLICT DO NOTHING)
  // devuelva el job ajeno y descarte esta inyección en silencio.
  // Formato idéntico al de la edge (`omnivore-helper.ts::enqueueOmnivoreInjection`) para que
  // ambos productores dedupliquen entre sí. Los step-keys derivan de esta base.
  const idempotencyKey = `pos_inject:${params.posProvider}:${params.siteId}:${params.orderId}`;

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
  // Robustez multi-tenant: la llave lleva `site_id`. `payments.id` NO es global (PK compuesta
  // `(id, site_id)`) e `integration_jobs.idempotency_key` es UNIQUE GLOBAL. Sin el site, un
  // `payment.id` que otro tenant ya usó hace que `enqueue_job` devuelva el job ajeno y el pago
  // NUNCA se aplique al POS: el cheque queda abierto en Aloha mientras MCM lo da por cobrado,
  // sin error, sin dead-letter y sin alerta. Confirmado en vivo el 2026-08-07 (pago 10246 del
  // site 99990003 contra un job del site 48372619 del 10 de junio).
  // Formato idéntico al de la edge (`omnivore-helper.ts::enqueueOmnivorePaymentInjection`) para
  // que ambos productores dedupliquen entre sí. El step-key deriva de esta base.
  const idempotencyKey = `pos_pay:${params.posProvider}:${params.siteId}:${params.paymentId}`;

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
  /**
   * Nombre visible de la orden en el Register de Clover. Cosmético: la identidad la
   * llevan `externalReferenceId` y `clover_ticket_id`, nadie busca por el título.
   * Por defecto `MCM #{id} (add'l)`; el llamador pasa el nombre de la mesa cuando lo tiene.
   */
  title?: string;
}): Promise<string> {
  // Multi-tenant: mismo motivo que arriba — `orders.id` no es global. Aquí la firma del delta
  // reduce la probabilidad de choque, pero no lo impide por diseño.
  const idem = `clover_supp_inject:${params.siteId}:${params.orderId}:${params.deltaSignature}`;

  const orderBody: Record<string, unknown> = {
    title: params.title ?? `MCM #${params.orderId} (add'l)`,
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

// ── enqueueDeliveryDispatch ──────────────────────────────────

/**
 * Enqueues a 1-step delivery dispatch job (cola `order_actions`). El handler `delivery.dispatch`
 * invoca la edge fn `delivery-create` (idempotente). El producer real es la edge fn
 * `order-notification-status-change-trigger` (al pasar a in-kitchen) y la edge fn `delivery-dispatch`
 * (POS / "Llamar Uber") vía la RPC `enqueue_job` directamente — este helper documenta el contrato y
 * sirve para enqueue desde Node si hiciera falta. Returns the job ID (o null si fue deduplicado).
 */
export async function enqueueDeliveryDispatch(params: {
  siteId: number;
  orderId: string | number;
  test?: boolean;
  /** Fuerza un job nuevo (re-dispatch manual): evita el dedup por orden. */
  force?: boolean;
  correlationId?: string;
}): Promise<string | null> {
  const base = `delivery_dispatch:${params.siteId}:${params.orderId}`;
  const idempotencyKey = params.force ? `${base}:${randomUUID()}` : base;

  const { data, error } = await supabase.rpc('enqueue_job', {
    p_site_id: params.siteId,
    p_queue_name: 'order_actions',
    p_job_type: 'delivery_dispatch',
    p_integration: 'delivery',
    p_idempotency_key: idempotencyKey,
    p_payload: { site_id: params.siteId, order_id: params.orderId, test: params.test ?? false },
    p_total_steps: 1,
    p_steps: [{ step_name: 'dispatch', max_attempts: 5, idempotency_key: `${idempotencyKey}:dispatch` }],
    p_priority: 7,
    p_reference_type: 'order',
    p_reference_id: String(params.orderId),
    p_correlation_id: params.correlationId ?? null,
  });

  if (error) throw new HandlerError(`enqueue_job failed: ${error.message}`, 'ENQUEUE_FAILED', false);
  return (data as string) ?? null; // null = deduplicado (ya encolado)
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
