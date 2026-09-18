import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { HandlerError, JobStep } from '../../../core/types';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapOmnivoreError, assertNoOmnivoreErrors } from '../error-map';
import { getTicketTotals, idempotencyId, persistPaymentIssue, reconcileOrderIssues, willTerminate } from './shared';
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
 * Idempotency (header-independent): if the MCM payment already carries the
 * applied marker (`additional_properties.omnivore_payment_id`, or a legacy
 * `pos_id`), it was applied — skip. On success we persist the Omnivore payment
 * id as that marker (and best-effort into `payments.pos_id`, see below).
 */
/**
 * Dónde vive la marca «aplicado a Omnivore» del `payments`.
 *
 * Desde el 2026-09-18 la marca es SIEMPRE `additional_properties.omnivore_payment_id`, para todos los
 * pagos. Antes el default era `payments.pos_id`, y eso lleva roto desde el 15-sep en los tres sites
 * vivos: Aloha RECICLA los ids de tender (Numen rota entre ~40 ids) y `payments_site_pos_id_uniq
 * (site_id, pos_id)` rechaza el UPDATE con 23505 — que además se ignoraba. Sin marca, un reintento
 * tras un ACK perdido vuelve a postear el tender (cobro doble). Medido: 27/27 (Numen), 52/52 (Arena
 * Medalla) y 1/1 (Coca-Cola) de los jobs de pago completados chocaban con un pago anterior del site.
 *
 * El índice NO se toca (el pull de pagos de Clover hace upsert sobre él y exige que sea no-parcial).
 * `pos_id` se sigue escribiendo best-effort —vale como dato informativo cuando no choca— pero su
 * error va al log en vez de tragarse, y la lectura mira las dos casillas (los pagos viejos con
 * `pos_id` siguen contando como aplicados).
 *
 * `pos_id_field` en el payload sigue existiendo por el camino Clover-pull → Omnivore forward
 * (`upsert-payments.ts`): ahí `pos_id` guarda el id de CLOVER y no debe ni leerse ni escribirse.
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
 * Vive en `additional_properties.omnivore_payment_id` (una constante en `pos_id` sólo podía existir
 * una vez por site: chocaba con `payments_site_pos_id_uniq` a la segunda). Las guardas de
 * reanudación preguntan «¿hay algo?», no «¿qué id es?», así que cualquier intento posterior sale
 * por `already_applied` sin postear.
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

/**
 * ¿Ya está aplicado? Mira la marca jsonb y, salvo en el camino Clover-forward (donde `pos_id` es el
 * id de Clover), también `pos_id` (pagos anteriores al 2026-09-18). Si la lectura falla NO se
 * asume «no aplicado»: se lanza retryable y no se postea a ciegas (mismo criterio que Clover).
 */
async function readOmnivoreApplied(
  siteId: number,
  paymentId: unknown,
  posIdField: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('payments')
    .select('pos_id, additional_properties')
    .eq('id', paymentId)
    .eq('site_id', siteId)
    .maybeSingle();
  if (error) {
    throw new HandlerError(
      `omnivore payment: no se pudo leer el estado del pago ${paymentId} (${error.message})`,
      'OMNIVORE_PAYMENT_STATE_READ_FAILED', true,
    );
  }
  const ap = (data?.additional_properties ?? {}) as Record<string, unknown>;
  const marker = ap.omnivore_payment_id;
  if (marker != null && String(marker) !== '') return String(marker);
  if (posIdField === OMNIVORE_MARKER_FIELD) return null;
  const posId = data?.pos_id;
  return posId != null && String(posId) !== '' ? String(posId) : null;
}

/**
 * Mezcla `patch` en `payments.additional_properties` (leer-modificar-escribir; un solo job por pago,
 * `pos_pay:omnivore:<site>:<payment>`). El error se LOGUEA, nunca se lanza: el tender ya entró y
 * relanzar haría que el reintento lo volviera a postear.
 */
async function mergePaymentAdditionalProperties(
  siteId: number,
  paymentId: unknown,
  patch: Record<string, unknown>,
  what: string,
): Promise<void> {
  const { data, error: readErr } = await supabase
    .from('payments')
    .select('additional_properties')
    .eq('id', paymentId)
    .eq('site_id', siteId)
    .maybeSingle();
  if (readErr) {
    logger.error({ error: readErr, site_id: siteId, payment_id: paymentId, what }, 'omnivore payment: failed to read additional_properties');
  }
  const ap = { ...((data?.additional_properties ?? {}) as Record<string, unknown>), ...patch };
  const { error } = await supabase
    .from('payments')
    .update({ additional_properties: ap })
    .eq('id', paymentId)
    .eq('site_id', siteId);
  if (error) {
    logger.error({ error, site_id: siteId, payment_id: paymentId, what, patch }, 'omnivore payment: failed to write additional_properties');
  }
}

async function writeOmnivoreApplied(
  siteId: number,
  paymentId: unknown,
  posIdField: string,
  value: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  // 1. La marca de verdad: jsonb, sin índice único que la rechace.
  await mergePaymentAdditionalProperties(siteId, paymentId, { omnivore_payment_id: value, ...extra }, 'applied marker');
  // 2. `pos_id` best-effort (informativo). Nunca en el camino Clover-forward: ahí guarda el id de Clover.
  if (posIdField === OMNIVORE_MARKER_FIELD) return;
  const { error } = await supabase
    .from('payments')
    .update({ pos_id: value })
    .eq('id', paymentId)
    .eq('site_id', siteId);
  if (error) {
    logger.warn(
      { error: error.message, code: (error as { code?: string }).code, site_id: siteId, payment_id: paymentId, omnivore_payment_id: value },
      'omnivore payment: pos_id no escrito (id de tender reciclado por el POS choca con payments_site_pos_id_uniq); la marca vive en additional_properties.omnivore_payment_id',
    );
  }
}

/** Nota de sistema en la orden (la muestra el dashboard y no la limpia nadie, al contrario que `orders.issues`). */
async function appendSystemOrderNote(siteId: number, orderId: unknown, content: string): Promise<void> {
  if (orderId === undefined || orderId === null) return;
  const { error } = await supabase
    .from('order_notes')
    .insert({ site_id: siteId, order_id: orderId, content, is_system: true });
  if (error) {
    logger.error({ error, site_id: siteId, order_id: orderId }, 'omnivore payment: failed to append order note');
  }
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

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

  // ── Saldo del ticket ANTES de postear (incidente 10614, 2026-09-18) ────────────────────────────
  //
  // El terminal cobró $145.36 (total de vista previa de MCM) contra un ticket de $144.87 (Aloha), y un
  // tender mayor que el `due` NO devuelve `excessive_payment`: Aloha responde `pos_failure` (caso ya
  // documentado en `omnivore-helper.ts` con Chili's), el job murió a los 5 intentos y la mesa quedó
  // abierta. Decisión del dueño: lo importante es CERRAR la mesa; la diferencia se maneja a mano.
  //   - amount > due  → se postea el `due` (propina intacta) y la diferencia queda anotada en tres
  //                     sitios: `order_notes` (nota de sistema, visible y permanente), el pago
  //                     (`additional_properties.omnivore_tender_adjustment`) y la salida del job.
  //   - due == 0      → el ticket ya está pagado: no se postea nada (sería un tender de más), nota.
  //   - amount <= due → igual que siempre (splits y pagos parciales).
  // Si el GET falla no se postea a ciegas (retryable), mismo criterio que el reconcile de arriba.
  let totals;
  try {
    totals = await getTicketTotals(client, ticketId);
  } catch (totalsErr) {
    throw mapOmnivoreError(totalsErr, 'OMNIVORE_PAYMENT_RECONCILE_FAILED');
  }
  const requestedAmount = Number(paymentBody['amount'] ?? 0);
  const due = typeof totals.due === 'number' && Number.isFinite(totals.due) ? totals.due : null;
  let bodyToPost: Record<string, unknown> = paymentBody;
  let adjustment: Record<string, unknown> | null = null;
  if (due != null && due <= 0 && requestedAmount > 0) {
    const nota =
      `El pago ${paymentId ?? '?'} (${usd(requestedAmount)} cobrados en el terminal) no se aplicó al POS: el ticket ` +
      `${ticketId} ya estaba pagado (saldo ${usd(due)}, ${totals.paymentCount} tender(s)). Revisar a mano.`;
    logger.warn({ site_id: job.site_id, order_id: orderId, payment_id: paymentId, ticket_id: ticketId, requested: requestedAmount, due, tenders: totals.paymentCount }, 'omnivore payment: ticket already paid, tender not posted');
    await appendSystemOrderNote(job.site_id, orderId, nota);
    if (paymentId != null) {
      await mergePaymentAdditionalProperties(job.site_id, paymentId, {
        omnivore_tender_adjustment: { kind: 'ticket_already_paid', requested: requestedAmount, applied: 0, due, difference: requestedAmount, ticket_id: ticketId, at: new Date().toISOString() },
      }, 'ticket_already_paid');
    }
    await reconcileOrderIssues(job.site_id, orderId, job.id);
    return { skipped: 'ticket_already_paid', due, requested: requestedAmount, tenders_en_ticket: totals.paymentCount };
  }
  if (due != null && requestedAmount > due) {
    bodyToPost = { ...paymentBody, amount: due };
    adjustment = { kind: 'amount_capped_to_due', requested: requestedAmount, applied: due, due, difference: requestedAmount - due, ticket_id: ticketId, at: new Date().toISOString() };
    logger.warn({ site_id: job.site_id, order_id: orderId, payment_id: paymentId, ticket_id: ticketId, requested: requestedAmount, due }, 'omnivore payment: amount exceeds ticket due, posting the due');
  }

  try {
    const res = await client.post<{ id: string }>(`/tickets/${ticketId}/payments`, bodyToPost, {
      headers: { 'Idempotency-Id': idempotencyId(step, job, 'payment_injection') },
    });
    assertNoOmnivoreErrors(res.data);

    const omnivorePaymentId = res.data?.id ?? null;
    if (paymentId != null && omnivorePaymentId) {
      await writeOmnivoreApplied(job.site_id, paymentId, posIdField, omnivorePaymentId, adjustment ? { omnivore_tender_adjustment: adjustment } : {});
    }
    if (adjustment) {
      await appendSystemOrderNote(
        job.site_id,
        orderId,
        `Ajuste automático del pago al POS: el terminal cobró ${usd(requestedAmount)} y el ticket ${ticketId} debía ${usd(due as number)}; ` +
          `se aplicó ${usd(due as number)} en el POS (tender ${omnivorePaymentId ?? '?'}). Diferencia de ${usd(requestedAmount - (due as number))} ` +
          `pendiente de manejar a mano (pago ${paymentId ?? '?'}).`,
      );
    }
    // Inyección OK: sana el flag de la orden si todos sus pagos están sincronizados.
    await reconcileOrderIssues(job.site_id, orderId, job.id);
    return adjustment
      ? { omnivore_payment_id: omnivorePaymentId, adjusted: true, requested: requestedAmount, applied: due, due }
      : { omnivore_payment_id: omnivorePaymentId };
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
