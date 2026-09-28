import { supabase } from '../../lib/supabase';

// Acceso a datos del módulo de Suscripciones para los handlers de la cola 'billing'.
// Multi-tenant: TODA consulta filtra por site_id explícitamente (service_role salta la RLS).

export interface PaymentRow {
  id: number; site_id: number; status: string; method: string | null;
  total: number | null; orders_ids: number[] | null;
  data: Record<string, any> | null; additional_properties: Record<string, any> | null;
}

export interface OrderRow {
  id: number; site_id: number;
  line_items: any[] | null;
  customer: Record<string, any> | null;
  /**
   * El cliente que el CRM ya vinculo a esta orden.
   *
   * Importa: sin esto la suscripcion nacia con `customer_id` NULL y solo se ataba a su dueño cuando
   * el comprador se REGISTRABA. Quien compra como invitado y entra luego por otra via se quedaba con
   * una suscripcion huerfana que su propio portal no le enseñaba.
   */
  crm_customer_id: string | null;
  // Lleva la marca `subs.period_id` de una orden de RENOVACION. Sin traerla, la guarda que impide
  // crear una suscripcion nueva en cada cobro mensual no puede leer lo que comprueba.
  additional_properties: Record<string, any> | null;
}

export interface PlanTermRow {
  id: string; site_id: number; code: string;
  interval_unit: string; interval_count: number;
  product_id: number; variation_id: string | null;
}

export interface SubsSettingsRow {
  site_id: number; is_enabled: boolean; auto_collection_max_interval_months: number;
  /** Configuración libre del negocio (`subs_settings.config`); p. ej. `close_plan_only_orders` (D-054). */
  config?: Record<string, unknown> | null;
}

export async function loadPayment(paymentId: number, siteId: number): Promise<PaymentRow | null> {
  const { data } = await supabase.from('payments')
    .select('id, site_id, status, method, total, orders_ids, data, additional_properties')
    .eq('id', paymentId).eq('site_id', siteId).maybeSingle();
  return (data as PaymentRow) ?? null;
}

export async function loadOrders(orderIds: number[], siteId: number): Promise<OrderRow[]> {
  if (orderIds.length === 0) return [];
  const { data } = await supabase.from('orders')
    .select('id, site_id, line_items, customer, additional_properties, crm_customer_id, coupon_feedback, discount_total')
    .eq('site_id', siteId).in('id', orderIds);
  return (data as OrderRow[]) ?? [];
}

export async function loadSettings(siteId: number): Promise<SubsSettingsRow | null> {
  const { data } = await supabase.from('subs_settings')
    .select('site_id, is_enabled, auto_collection_max_interval_months, config')
    .eq('site_id', siteId).maybeSingle();
  return (data as SubsSettingsRow) ?? null;
}

/** Los términos publicados del negocio, para casar las líneas de la orden contra el catálogo. */
export async function loadPublishedTerms(siteId: number): Promise<PlanTermRow[]> {
  const { data } = await supabase.from('subs_plan_terms')
    .select('id, site_id, code, interval_unit, interval_count, product_id, variation_id')
    .eq('site_id', siteId).eq('status', 'published');
  return (data as PlanTermRow[]) ?? [];
}

/** ¿Esta orden ya generó suscripciones? Es la guarda de idempotencia del handler. */
export async function subscriptionsForOrder(siteId: number, orderId: number): Promise<string[]> {
  const { data } = await supabase.from('subs_subscriptions')
    .select('id').eq('site_id', siteId).eq('source_order_id', orderId);
  return ((data as any[]) ?? []).map((r) => r.id as string);
}

/** Unidades de la orden que ya tienen suscripción (R2): (línea, unidad) de `metadata`. */
export async function existingUnitsForOrder(
  siteId: number, orderId: number,
): Promise<{ line_item_id: string | null; unit_index: number | null }[]> {
  const { data, error } = await supabase.from('subs_subscriptions')
    .select('metadata').eq('site_id', siteId).eq('source_order_id', orderId);
  if (error) throw new Error(`existing_units_failed: ${error.message}`);
  return ((data as any[]) ?? []).map((r) => ({
    line_item_id: r?.metadata?.line_item_id ?? null,
    unit_index: r?.metadata?.unit_index ?? null,
  }));
}

/**
 * Cliente dueño de la CUENTA con este email (R8). En MCM la ficha CRM es única por teléfono y la cuenta del portal es
 * única por email (`subs_credentials_email_uq`): si el email ya tiene cuenta, la suscripción va a ESA cuenta, aunque el
 * teléfono del checkout sea de otra ficha — así quien entra con su email ve lo que compró.
 */
export async function customerIdByAccountEmail(siteId: number, email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const { data, error } = await supabase.from('subs_customer_credentials')
    .select('customer_id, email').eq('site_id', siteId).eq('email', e).limit(2);
  if (error) throw new Error(`account_by_email_failed: ${error.message}`);
  const rows = (data as any[]) ?? [];
  return rows.length === 1 ? String(rows[0].customer_id) : null;
}

/**
 * Deja la tarjeta nueva como la predeterminada: el índice `subs_instruments_default_uq` admite UNA activa por cliente,
 * así que primero se quita la marca a las demás (si no, el upsert de un cliente que vuelve con otra tarjeta falla).
 */
export async function demoteOtherDefaults(siteId: number, customerId: string, keepPmId: string): Promise<void> {
  const { error } = await supabase.from('subs_instruments')
    .update({ is_default: false })
    .eq('site_id', siteId).eq('customer_id', customerId).eq('is_default', true)
    .neq('provider_pm_id', keepPmId);
  if (error) throw new Error(`demote_defaults_failed: ${error.message}`);
}

export async function insertSubscription(row: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase.from('subs_subscriptions').insert(row).select('id').single();
  if (error) throw new Error(`subscription_insert_failed: ${error.message}`);
  return (data as any)?.id ?? null;
}

export async function insertFirstPeriod(row: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('subs_periods').insert(row);
  if (error) throw new Error(`period_insert_failed: ${error.message}`);
}

export async function logEvents(rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from('subs_events').insert(rows);
  // La bitácora no puede tumbar la creación de una suscripción ya cobrada.
  if (error) console.error('[subs] no se pudo registrar el evento:', error.message);
}

export async function loadStripeAccount(siteId: number): Promise<string | null> {
  const { data } = await supabase.from('sites')
    .select('stripe_account_id').eq('id', siteId).maybeSingle();
  const acct = (data as any)?.stripe_account_id;
  return acct ? String(acct) : null;
}

export async function upsertInstrument(row: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase.from('subs_instruments')
    .upsert(row, { onConflict: 'site_id,provider,provider_pm_id' })
    .select('id').single();
  if (error) throw new Error(`instrument_upsert_failed: ${error.message}`);
  return (data as any)?.id ?? null;
}

/** Liga el instrumento a las suscripciones de cobro automático de esa orden. */
export async function attachInstrumentToOrder(
  siteId: number, orderId: number, instrumentId: string,
): Promise<number> {
  const { data, error } = await supabase.from('subs_subscriptions')
    .update({ instrument_id: instrumentId })
    .eq('site_id', siteId).eq('source_order_id', orderId).eq('collection', 'auto')
    .is('instrument_id', null)
    .select('id');
  if (error) throw new Error(`attach_instrument_failed: ${error.message}`);
  return ((data as any[]) ?? []).length;
}

/**
 * Encola un job de la cola `billing` desde otro handler.
 *
 * No hay un helper genérico en el engine: cada dominio escribe el suyo llamando a la RPC. La llave
 * de idempotencia lleva SIEMPRE el `site_id`, porque `integration_jobs.idempotency_key` es UNIQUE
 * GLOBAL y los ids de orden/pago NO son globales (PK compuesta con el site): sin él, un id que ya
 * exista en otro negocio haría que `enqueue_job` (ON CONFLICT DO NOTHING) devolviera el job ajeno y
 * descartara éste en silencio.
 */
export async function enqueueSubsJob(params: {
  siteId: number; jobType: string; idempotencyKey: string;
  payload: Record<string, unknown>; steps: { step_name: string; max_attempts?: number }[];
  priority?: number; referenceType?: string; referenceId?: string;
}): Promise<string | null> {
  const { data, error } = await supabase.rpc('enqueue_job', {
    p_site_id: params.siteId,
    p_queue_name: 'billing',
    p_job_type: params.jobType,
    p_integration: 'subs',
    p_idempotency_key: params.idempotencyKey,
    p_payload: params.payload,
    p_total_steps: params.steps.length,
    p_steps: params.steps.map((s) => ({
      step_name: s.step_name,
      max_attempts: s.max_attempts ?? 3,
      idempotency_key: `${params.idempotencyKey}:${s.step_name}`,
    })),
    p_priority: params.priority ?? 5,
    p_reference_type: params.referenceType ?? null,
    p_reference_id: params.referenceId ?? null,
    p_correlation_id: null,
  });
  if (error) {
    // Non-fatal a propósito: la suscripción ya está creada y cobrada. Que no se pueda encolar la
    // cosecha de la tarjeta no puede revertir eso.
    console.error('[subs] enqueue fallo (non-fatal):', error.message);
    return null;
  }
  return (data as string) ?? null;
}

/**
 * Descuento RECURRENTE que hereda una suscripción nacida de esta orden, si el cupón aplicado
 * declara una duración mayor que «sólo la compra».
 *
 * El `coupon_id` NO se guarda en `orders` (es un campo de trabajo del calculador), así que sale de
 * `coupon_redemptions`, que es la fila persistida y la fuente de verdad del canje.
 *
 * Devuelve `null` cuando no hay cupón, cuando no tiene término declarado, o cuando dura `once` —
 * que es el comportamiento de siempre: la compra ya se llevó su descuento y las renovaciones van a
 * precio de lista.
 */
export async function descuentoRecurrenteDeLaOrden(
  siteId: number,
  orderId: number,
): Promise<
  | { kind: 'percent' | 'fixed'; value: number; cyclesLeft: number | null; couponId: string; code: string }
  | null
> {
  const { data: red } = await supabase
    .from('coupon_redemptions')
    .select('coupon_id')
    .eq('order_site_id', siteId)
    .eq('order_id', orderId)
    .maybeSingle();
  if (!red?.coupon_id) return null;

  const { data: term } = await supabase
    .from('subs_coupon_terms')
    .select('duration, cycles')
    .eq('coupon_site_id', siteId)
    .eq('coupon_id', red.coupon_id)
    .maybeSingle();
  if (!term || term.duration === 'once') return null;

  const { data: cup } = await supabase
    .from('coupons')
    .select('type, discount_value, code')
    .eq('site_id', siteId)
    .eq('id', red.coupon_id)
    .maybeSingle();
  if (!cup) return null;

  const kind = cup.type === 'fixed' ? 'fixed' : 'percent';
  const value = Number(cup.discount_value ?? 0);
  if (!Number.isFinite(value) || value <= 0) return null;

  // La compra YA consumió el primer ciclo, así que a `repeating(N)` le quedan N-1 renovaciones.
  const cyclesLeft = term.duration === 'forever'
    ? null
    : Math.max(0, Number(term.cycles ?? 1) - 1);
  if (cyclesLeft === 0) return null;

  return { kind, value, cyclesLeft, couponId: red.coupon_id, code: String(cup.code ?? '') };
}

/**
 * El equipo que la compra pidió, SÓLO si se le puede atar un plan ahora mismo:
 * existe, es de ESTE negocio, es de ESTE cliente y todavía no tiene plan vivo.
 *
 * Cualquier otra cosa devuelve `null` y la suscripción nace `pending_activation`, que es el camino
 * de siempre. No se fuerza nada: un `asset_id` lo manda el navegador y no se cree por venir en el
 * cuerpo — se comprueba contra la base.
 */
export async function equipoActivable(
  siteId: number, assetId: string, customerId: string | null,
): Promise<{ id: string } | null> {
  if (!assetId || !customerId) return null;
  const { data, error } = await supabase
    .from('subs_assets')
    .select('id, customer_id, status')
    .eq('site_id', siteId)
    .eq('id', assetId)
    .maybeSingle();
  if (error || !data) return null;
  if (data.customer_id !== customerId) return null;
  // `active` también: un equipo cuyo plan se canceló sigue `active` y puede volver a llevar uno (revisión F5 #2). La guarda de
  // abajo («sin plan vivo») es la que impide dos planes en el mismo equipo.
  if (!['registered', 'in_stock', 'active'].includes(String(data.status))) return null;

  const { count } = await supabase
    .from('subs_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', siteId)
    .eq('asset_id', assetId)
    .in('status', ['active', 'past_due', 'grace', 'suspended']);
  if ((count ?? 0) > 0) return null;   // un equipo, un plan vigente

  return { id: String(data.id) };
}

/**
 * Orden SÓLO de planes (misión iOTEK D-054): no hay nada que preparar ni entregar, así que se cierra al aplicarse el pago —
 * como las órdenes de renovación, que el cobrador ya crea cerradas—. Sólo desde «nueva y pagada»: nunca reabre, ni pisa una
 * orden cancelada, ni una que el personal ya movió. Devuelve si la cerró.
 */
export async function cerrarOrdenSoloPlanes(siteId: number, orderId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from('orders')
    .update({ status: 'check-closed' })
    .eq('site_id', siteId)
    .eq('id', orderId)
    .eq('status', 'new-order')
    .eq('payment_status', 'fulfilled')
    .select('id');
  if (error) { console.error('[subs] no se pudo cerrar la orden de planes:', error.message); return false; }
  return (data?.length ?? 0) > 0;
}

/** Marca el equipo como activo al atarle su plan. */
/**
 * «Equipo activado» (D-056) cuando el plan nace ACTIVO sobre un equipo ya registrado (flujo c). Misma llave que la activación desde
 * `subs-asset-register` (`activated:<site>:<suscripción>`): un aviso por plan, venga de donde venga. En el idioma de la compra.
 * Nunca tumba el pago: si falla, se registra y sigue.
 */
export async function avisarEquipoActivado(
  siteId: number, subscriptionId: string, customerId: string, assetId: string, periodEnd: string, locale: 'es' | 'en',
): Promise<void> {
  const { data: id, error } = await supabase.rpc('subs_queue_notification', {
    p_site_id: siteId,
    p_subscription_id: subscriptionId,
    p_period_id: null,
    p_customer_id: customerId,
    p_kind: 'activated',
    p_dedupe_key: `activated:${siteId}:${subscriptionId}`,
    // A 1 min: el idioma se pone justo después del alta y ningún despacho la toma antes (revisión F6 #6).
    p_scheduled_for: new Date(Date.now() + 60_000).toISOString(),
    p_payload: { asset_id: assetId, period_end: periodEnd, locale },
  });
  if (error) { console.error('[subs] aviso «equipo activado» no encolado:', error.message); return; }
  // `subs_queue_notification` guarda `es`: el idioma de la compra se pone sobre la fila recién creada (sólo si sigue en cola).
  if (id && locale !== 'es') {
    await supabase.from('subs_notifications').update({ locale })
      .eq('site_id', siteId).eq('id', id).eq('status', 'queued');
  }
}

export async function activarEquipo(siteId: number, assetId: string): Promise<void> {
  const { error } = await supabase
    .from('subs_assets')
    .update({ status: 'active' })
    .eq('site_id', siteId)
    .eq('id', assetId);
  if (error) console.error('[subs] no se pudo activar el equipo:', error.message);
}
