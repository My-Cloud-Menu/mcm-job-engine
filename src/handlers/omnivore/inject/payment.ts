import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError, JobStep } from '../../../core/types';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import { idempotencyId, persistPaymentIssue, reconcileOrderIssues, willTerminate } from './shared';
import { isFireInFlight } from '../sync/fire-in-flight';

/**
 * Standalone payment injection (replaces the legacy `sendPaymentToOmnivore`).
 *
 * Applies an already-completed MCM payment to an existing Omnivore ticket. The
 * edge producer (`enqueueOmnivorePaymentInjection`) pre-builds the exact 3rd-
 * party payment body (tender mapping, amount/tip in cents, comment, cash
 * override) and freezes it under `jobPayload.payment`, along with `ticket_id`
 * (= `orders.pos_id`) and the MCM `payment_id` / `order_id`.
 *
 * Idempotency (header-independent): if the MCM payment already carries a
 * `pos_id`, it was applied — skip. On success we persist the Omnivore payment
 * id back to `payments.pos_id` (parity with the legacy flow).
 */
/**
 * Where the "applied to Omnivore" marker lives on the `payments` row. Default
 * `pos_id` (POS-originated payments). The Clover-pull → Omnivore forward passes
 * `additional_properties.omnivore_payment_id` because for a Clover-terminal
 * payment `pos_id` already holds the CLOVER payment id (upsert-payments.ts:212),
 * so reusing it would make the resume guard skip immediately and never apply.
 */
const OMNIVORE_MARKER_FIELD = 'additional_properties.omnivore_payment_id';

/**
 * CONTENCIÓN `ticket_locked` — el mesero tiene el ticket abierto en el terminal.
 *
 * Omnivore rechaza el tender con el slug `ticket_locked`, que `error-map.ts` clasifica como
 * error de NEGOCIO (no-retryable) → el job moría en dead_letter al primer intento. Pero no es
 * permanente: en cuanto el mesero se desloguea, el mismo POST entra. Aquí —y SOLO en este
 * handler standalone, no en `create_payment` dentro de `order_injection`— lo tratamos como
 * contención y reintentamos ~30 min.
 *
 * 31 intentos × 60s ≈ 30 min. El ritmo PLANO de 60s es deliberado: a 1 fallo por minuto un pago
 * trabado no puede acercarse al umbral del circuit breaker (10 fallos en 60s por
 * `(omnivore, pos_injection)`), así que no hace falta tocar el núcleo para excluirlo.
 *
 * Reintentar es seguro contra el doble-tender: el guard de reconcile-before-repost de abajo
 * corre en CADA reintento (`attempt_count > 0`) y, si un intento previo llegó a aplicar el pago,
 * lo detecta por `comment` + `amount` y sale sin re-postear.
 */
const TICKET_LOCKED_CODE = 'OMNIVORE_TICKET_LOCKED';
const TICKET_LOCKED_MAX_ATTEMPTS = 31;
const TICKET_LOCKED_RETRY_SECONDS = 60;

/**
 * COBRO DOBLE `Error closing ticket` — el POS aplicó el pago y falló DESPUÉS, al cerrar.
 *
 * Incidente medido en Numen (site VIVO) el 2026-08-27: el ticket `20260827-10027` acabó con DOS
 * tenders —`95420423` (importe 1) y `95420424` (importe 0, cambio 1)—. Su traza:
 *
 *   intento 1  400 ticket_locked   → rechazado, no aplicó nada
 *   intento 2  500 internal_error  → `metadata.reason: "Error closing ticket."` → APLICÓ el pago
 *   intento 3  200 éxito           → DUPLICADO
 *
 * `internal_error` vive en `OMNIVORE_RETRYABLE_SLUGS` junto a `agent_offline`, pero no son lo
 * mismo: `agent_offline` significa que la petición NO llegó al POS, mientras que este `reason` lo
 * emite el POS DESPUÉS de aplicar el tender. Reintentarlo cobra dos veces.
 *
 * El caso especial vive AQUÍ y no en `error-map.ts` a propósito: esa tabla la comparten
 * `create_order`, `add_items` y `create_payment`, donde reintentar un `internal_error` es
 * inofensivo. Mismo criterio —y mismo fichero— que el `ticket_locked` de arriba.
 */
const CLOSE_FAILED_SLUG = 'internal_error';
const CLOSE_FAILED_REASON = 'error closing ticket';
const CLOSE_FAILED_CODE = 'OMNIVORE_PAYMENT_APPLIED_CLOSE_FAILED';
/**
 * Marcador que se escribe donde iría el id del pago de Omnivore. No es un id: es la constancia de
 * que el tender entró aunque no sepamos su id (el POS falló antes de devolvérnoslo).
 *
 * Es seguro escribirlo ahí: `payments.pos_id` sólo lo leen las guardas de reanudación —esta misma y
 * la de Clover—, que preguntan «¿hay algo?», no «¿qué id es?». Verificado repo-wide: ningún camino
 * lo usa para direccionar al POS. Y al quedar poblado, cualquier intento posterior sale por
 * `already_applied` sin postear.
 */
const CLOSE_FAILED_MARKER = 'applied_close_failed';

/**
 * ¿Es este error el «se aplicó el pago pero no cerró el ticket»?
 *
 * La comparación va NORMALIZADA (trim + minúsculas, y sin exigir el punto final) para que un
 * retoque cosmético del texto por parte de Omnivore no desactive la protección en silencio —
 * que es justo el modo de fallo que no nos podemos permitir en el camino del dinero.
 */
function esCierreFallidoTrasAplicar(responseBody: unknown): boolean {
  const err = (responseBody as { errors?: Array<Record<string, unknown>> })?.errors?.[0];
  if (!err) return false;
  if (String(err['error'] ?? '').toLowerCase() !== CLOSE_FAILED_SLUG) return false;
  const reason = (err['metadata'] as { reason?: unknown } | undefined)?.reason;
  return String(reason ?? '').trim().toLowerCase().replace(/\.$/, '') === CLOSE_FAILED_REASON;
}

/**
 * Convierte el error de contención en retryable y le sube el techo de intentos AL PROPIO STEP.
 *
 * Los productores encolan con `max_attempts: 5` (edge `enqueueOmnivorePaymentInjection`); subir
 * ese literal obligaría a redesplegar ~20 edge functions del camino de cobro, así que el techo
 * se eleva aquí. Se persiste en `job_steps` —`getJobSteps` relee la fila en cada ejecución del
 * job, así que los reintentos siguientes lo ven— y además se muta en memoria para que el
 * `attemptNumber < step.max_attempts` del executor lo respete ya en esta misma pasada.
 *
 * Si el UPDATE falla, degrada de forma segura: el step conserva su techo original y el job
 * simplemente agota antes sus intentos.
 */
async function escalateTicketLockedRetry(he: HandlerError, step: JobStep): Promise<HandlerError> {
  if (step.max_attempts < TICKET_LOCKED_MAX_ATTEMPTS) {
    const { error } = await supabase
      .from('job_steps')
      .update({ max_attempts: TICKET_LOCKED_MAX_ATTEMPTS })
      .eq('id', step.id)
      .lt('max_attempts', TICKET_LOCKED_MAX_ATTEMPTS);
    if (error) {
      logger.error({ error, step_id: step.id }, 'omnivore payment: failed to raise max_attempts for ticket_locked');
    } else {
      step.max_attempts = TICKET_LOCKED_MAX_ATTEMPTS;
    }
  }

  // `retryAfterSeconds` gana sobre el perfil de backoff en el executor, así que el perfil
  // compartido `payment_injection: [30,30,30,30]` queda intacto para el resto de errores y para
  // el `payment_injection` de Clover. ±10% de jitter para no sincronizar varios pagos trabados.
  const retryAfterSeconds = Math.round(TICKET_LOCKED_RETRY_SECONDS * (1 + (Math.random() * 0.2 - 0.1)));

  return new HandlerError(he.message, he.code, true, he.statusCode, he.responseBody, retryAfterSeconds);
}

/**
 * Ítems fuera del POS (2026-09-18, defensa en profundidad del guard de cobro del edge).
 *
 * Si la orden gestionada tiene líneas vivas sin `omnivore.item_id` (nunca llegaron al ticket) o un
 * fire en vuelo (`omnivore_fire.in_flight_until`), postear el tender ahora falla o cobra de menos:
 * el `amount` viene del total de MCM y el `due` del ticket no lo cubre. Se espera con reintentos
 * planos de 15 s (misma mecánica que `ticket_locked`) hasta ~5 min; si sigue así, dead-letter con
 * motivo claro (`items_not_in_pos`) en vez del «Omnivore bug» opaco de hoy. Con el guard del edge
 * activo esto casi nunca se ejercita; cubre la bandera apagada y los fires que fallaron.
 */
const ITEMS_NOT_IN_POS_CODE = 'OMNIVORE_ITEMS_NOT_IN_POS';
const ITEMS_NOT_IN_POS_RETRY_SECONDS = 15;
const ITEMS_NOT_IN_POS_MAX_ATTEMPTS = 20;

function omniIdsOf(li: any): string[] {
  const o = li?.additional_properties?.omnivore;
  if (!o) return [];
  const ids: string[] = [];
  if (Array.isArray(o.item_ids)) for (const x of o.item_ids) if (x != null) ids.push(String(x));
  if (o.item_id != null) { const s = String(o.item_id); if (!ids.includes(s)) ids.push(s); }
  return ids;
}

export async function assertItemsInPos(siteId: number, orderId: unknown, paymentId: unknown, step: JobStep): Promise<void> {
  if (orderId == null) return;
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, line_items, additional_properties')
    .eq('site_id', siteId)
    .eq('id', orderId)
    .maybeSingle();
  if (error || !order) return; // sin lectura no se bloquea (el resto de guards sigue vivo)
  if ((order as any).additional_properties?.omnivore_managed !== true) return;
  const lines: any[] = Array.isArray((order as any).line_items) ? (order as any).line_items : [];
  const unfired = lines.filter((li) => li?.status !== 'sent' && li?.status !== 'voided' && omniIdsOf(li).length === 0);
  const inFlight = isFireInFlight((order as any).additional_properties);
  if (unfired.length === 0 && !inFlight) return;

  if (step.max_attempts < ITEMS_NOT_IN_POS_MAX_ATTEMPTS) {
    const { error: updErr } = await supabase
      .from('job_steps')
      .update({ max_attempts: ITEMS_NOT_IN_POS_MAX_ATTEMPTS })
      .eq('id', step.id)
      .lt('max_attempts', ITEMS_NOT_IN_POS_MAX_ATTEMPTS);
    if (updErr) logger.error({ error: updErr, step_id: step.id }, 'omnivore payment: failed to raise max_attempts for items_not_in_pos');
    else step.max_attempts = ITEMS_NOT_IN_POS_MAX_ATTEMPTS;
  }
  const reason = inFlight ? 'fire en vuelo' : `${unfired.length} línea(s) sin enviar al POS`;
  const msg = `Omnivore items_not_in_pos: la orden ${orderId} tiene ${reason}; el pago se reintenta cuando el fire termine.`;
  const he = new HandlerError(msg, ITEMS_NOT_IN_POS_CODE, true, undefined, { reason, unfired: unfired.map((li) => li.id) }, ITEMS_NOT_IN_POS_RETRY_SECONDS);
  if (willTerminate(true, step)) {
    await persistPaymentIssue(siteId, orderId, paymentId ?? null, he);
  }
  throw he;
}

async function readOmnivoreApplied(
  siteId: number,
  paymentId: unknown,
  posIdField: string
): Promise<string | null> {
  if (posIdField === OMNIVORE_MARKER_FIELD) {
    const { data } = await supabase
      .from('payments')
      .select('additional_properties')
      .eq('id', paymentId)
      .eq('site_id', siteId)
      .maybeSingle();
    const ap = (data?.additional_properties ?? {}) as Record<string, unknown>;
    return (ap.omnivore_payment_id as string) ?? null;
  }
  const { data } = await supabase
    .from('payments')
    .select('pos_id')
    .eq('id', paymentId)
    .eq('site_id', siteId)
    .maybeSingle();
  return (data?.pos_id as string) ?? null;
}

async function writeOmnivoreApplied(
  siteId: number,
  paymentId: unknown,
  posIdField: string,
  value: string
): Promise<void> {
  if (posIdField === OMNIVORE_MARKER_FIELD) {
    const { data } = await supabase
      .from('payments')
      .select('additional_properties')
      .eq('id', paymentId)
      .eq('site_id', siteId)
      .maybeSingle();
    const ap = {
      ...((data?.additional_properties ?? {}) as Record<string, unknown>),
      omnivore_payment_id: value,
    };
    await supabase
      .from('payments')
      .update({ additional_properties: ap })
      .eq('id', paymentId)
      .eq('site_id', siteId);
    return;
  }
  await supabase
    .from('payments')
    .update({ pos_id: value })
    .eq('id', paymentId)
    .eq('site_id', siteId);
}

registerHandler('omnivore', 'payment_injection', async ({ jobPayload, job, step }) => {
  const ticketId = jobPayload['ticket_id'] as string | undefined;
  const paymentId = jobPayload['payment_id'];
  const orderId = jobPayload['order_id'];
  const paymentBody = jobPayload['payment'] as Record<string, unknown> | undefined;
  // Resume marker location (default `pos_id`; Clover-pull forward overrides it).
  const posIdField = (jobPayload['pos_id_field'] as string) || 'pos_id';

  if (!ticketId) {
    throw new HandlerError('payment_injection payload missing ticket_id', 'MISSING_TICKET_ID', false);
  }
  if (!paymentBody || typeof paymentBody !== 'object') {
    throw new HandlerError('payment_injection payload missing payment body', 'MISSING_PAYMENT_BODY', false);
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), job.correlation_id);

  // Resume guard: this MCM payment already has an Omnivore id ⇒ already applied.
  if (paymentId != null) {
    const applied = await readOmnivoreApplied(job.site_id, paymentId, posIdField);
    if (applied) {
      // Ya aplicado: sana el flag de la orden si todos sus pagos están sincronizados.
      await reconcileOrderIssues(job.site_id, orderId, job.id);
      return { skipped: 'already_applied', omnivore_payment_id: applied };
    }
  }

  // Ítems fuera del POS / fire en vuelo → esperar (retryable) antes de postear el tender.
  await assertItemsInPos(job.site_id, orderId, paymentId, step);

  // Reconcile-before-repost. Solo en RETRY (attempt_count > 0). Lo que SIGUE vivo aquí es la
  // guarda que de verdad protege: si el GET falla, NO POSTeamos (throw retryable) — nunca se
  // re-postea a ciegas sobre un ticket que no hemos podido mirar.
  //
  // EL MATCH POR `comment` SE RETIRÓ (2026-08-27) PORQUE ESTABA MUERTO, medido contra el POS:
  //
  //   1. El POS NO devuelve el comentario. Leyendo `/tickets/{id}/payments` en Numen, el campo
  //      viene `comment: null` en todos los tenders. La comparación era `null === "Invoice #: …"`,
  //      es decir FALSA SIEMPRE. Huella en producción: 0 adopciones (`reconciled_lost_ack`) en
  //      2.028 inyecciones, con 57 reintentos que llegaron a ejecutar el guard y re-postearon igual.
  //   2. Y aunque volviera, NO ES ÚNICO: se construye como `Invoice #: <invoice|reference>`
  //      (edge `omnivore-helper.ts:612`) y en Numen los 4 pagos generan el mismo `Invoice #: 000935`;
  //      en Arena Medalla el 83 % de los pagos no tiene `invoice`. Mantenerlo arriesgaba el fallo
  //      CONTRARIO al que pretendía evitar: adoptar el tender de OTRO pago y perder uno real.
  //
  // Atribuir un tender a NUESTRO pago sin ancla exige comparar la lista de ids ANTES y DESPUÉS
  // (fotografía previa). Queda como follow-up; el log de abajo recoge los datos para dimensionarlo.
  if (paymentId != null && step.attempt_count > 0) {
    let existing: any[] = [];
    try {
      const recon = await client.get<{ _embedded?: { payments?: any[] } }>(`/tickets/${ticketId}/payments`);
      existing = recon.data?._embedded?.payments ?? [];
    } catch (reconErr) {
      throw mapOmnivoreError(reconErr, 'OMNIVORE_PAYMENT_RECONCILE_FAILED');
    }
    logger.info(
      {
        site_id: job.site_id,
        ticket_id: ticketId,
        payment_id: paymentId,
        attempt: step.attempt_count + 1,
        tenders_en_ticket: existing.length,
        importes: existing.map((p: any) => p?.amount),
      },
      'omnivore payment: estado del ticket antes de re-postear',
    );
  }

  try {
    const res = await client.post<{ id: string }>(`/tickets/${ticketId}/payments`, paymentBody, {
      headers: { 'Idempotency-Id': idempotencyId(step, job, 'payment_injection') },
    });
    assertNoOmnivoreErrors(res.data);

    const omnivorePaymentId = res.data?.id ?? null;
    if (paymentId != null && omnivorePaymentId) {
      await writeOmnivoreApplied(job.site_id, paymentId, posIdField, omnivorePaymentId);
    }
    // Inyección OK: sana el flag de la orden si todos sus pagos están sincronizados.
    await reconcileOrderIssues(job.site_id, orderId, job.id);
    return { omnivore_payment_id: omnivorePaymentId };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapOmnivoreError(err, 'OMNIVORE_PAYMENT_FAILED');

    // El POS APLICÓ el pago y falló al cerrar el ticket. Reintentar aquí cobra dos veces (medido en
    // Numen: tenders 95420423 + 95420424). Dos cosas, no una:
    //
    //   1. NO reintentar.
    //   2. Dejar ESCRITO que el pago entró. Sin esto la orden se ve como «pago fallido», alguien lo
    //      reenvía a mano, y el duplicado entra por la otra puerta. El mensaje que ve la persona
    //      dice lo único que hay que hacer: cerrar el ticket en el terminal.
    //
    // Va ANTES del caso `ticket_locked` porque es el que toca dinero; son slugs distintos y no se
    // solapan, pero el orden deja explícita la prioridad.
    if (esCierreFallidoTrasAplicar(he.responseBody)) {
      if (paymentId != null) {
        await writeOmnivoreApplied(job.site_id, paymentId, posIdField, CLOSE_FAILED_MARKER);
      }
      await persistPaymentIssue(job.site_id, orderId, paymentId, {
        message: 'El pago entró en el POS pero el ticket no cerró: cerralo en el terminal.',
        responseBody: he.responseBody,
      });
      throw new HandlerError(he.message, CLOSE_FAILED_CODE, false, he.statusCode, he.responseBody);
    }

    // Ticket bloqueado por el mesero: reintentar ~30 min en vez de morir en el primer intento.
    // Se marca `orders.issues` desde YA (sin esperar a `willTerminate`) para que el pago pendiente
    // sea visible durante la espera; es un slot JSONB único que se sobrescribe, y
    // `reconcileOrderIssues` lo limpia solo cuando el pago finalmente entra.
    if (he.code === TICKET_LOCKED_CODE) {
      const retryable = await escalateTicketLockedRetry(he, step);
      await persistPaymentIssue(job.site_id, orderId, paymentId, retryable);
      throw retryable;
    }

    if (willTerminate(he.retryable, step)) {
      await persistPaymentIssue(job.site_id, orderId, paymentId, he);
    }
    throw he;
  }
});
