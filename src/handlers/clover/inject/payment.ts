import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';
import { supabase } from '../../../lib/supabase';
import { mapCloverError } from '../error-map';
import {
  persistInjectionError, willTerminate,
  persistCloverPaymentIssue, reconcileCloverOrderIssues,
} from './shared';

/**
 * Standalone Clover payment injection (replaces the legacy `sendPaymentToClover`).
 *
 * Applies an already-completed MCM payment to a Clover order. The edge producer
 * (`enqueueCloverPaymentInjection`) pre-builds the 3rd-party body (amount/tip,
 * tender, `externalPaymentId`) and freezes it with `ticket_id` (= the order's
 * `clover_ticket_id` or `pos_id`) and the MCM `payment_id`/`order_id`.
 *
 * Unlike Omnivore, the Clover order-injection job does NOT apply a payment, so
 * this is the only path that pays the Clover order. Idempotency:
 *  - skip if the MCM payment already has a `pos_id` (resume), and
 *  - on success, record `clover_payment_map` (clover_payment_id ↔ mcm_payment_id
 *    + external_payment_id) so the Clover→MCM payment pull can dedup + anti-loop.
 */
/**
 * ¿Esta nota de pago lleva NUESTRA ancla?
 *
 * No vale `includes`: el ancla es `mcm:pay:<site>:<payment_id>` y `mcm:pay:9:1` es PREFIJO de
 * `mcm:pay:9:19`. En una orden con DOS pagos de MCM cuyos ids sean prefijo uno de otro, el
 * reintento del primero adoptaria el pago del segundo, marcaria el suyo como aplicado y saldria
 * SIN COBRAR — dinero que falta, no que sobra.
 *
 * Se comprueba la FRONTERA en vez de cambiar el formato del ancla, para que los pagos ya posteados
 * con el formato actual sigan reconciliando.
 */
export function notaLlevaAncla(nota: unknown, ancla: string): boolean {
  const s = String(nota ?? '');
  let desde = 0;
  for (;;) {
    const i = s.indexOf(ancla, desde);
    if (i < 0) return false;
    // Si lo que sigue es alfanumerico, hemos casado un PREFIJO, no el ancla: `mcm:pay:9:19`
    // contiene `mcm:pay:9:1`. Se exige frontera para que solo cuente el token completo.
    const siguiente = s.charAt(i + ancla.length);
    if (siguiente === '' || !/[0-9A-Za-z]/.test(siguiente)) return true;
    desde = i + 1;
  }
}

registerHandler('clover', 'payment_injection', async ({ jobPayload, job, step }) => {
  const ticketId = jobPayload['ticket_id'] as string | undefined;
  const paymentId = jobPayload['payment_id'];
  const orderId = jobPayload['order_id'];
  const paymentBody = jobPayload['payment'] as Record<string, unknown> | undefined;
  const externalPaymentId = jobPayload['external_payment_id'] as string | undefined;

  if (!ticketId) {
    throw new HandlerError('Clover payment_injection payload missing ticket_id', 'MISSING_TICKET_ID', false);
  }
  if (!paymentBody || typeof paymentBody !== 'object') {
    throw new HandlerError('Clover payment_injection payload missing payment body', 'MISSING_PAYMENT_BODY', false);
  }

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const client = createCloverClient(CloverConfigSchema.parse(config), job.correlation_id, job.site_id);

  // Resume guard: this MCM payment already has a POS id ⇒ already applied.
  if (paymentId != null) {
    const { data: existing, error: errExisting } = await supabase
      .from('payments')
      .select('pos_id')
      .eq('id', paymentId)
      .eq('site_id', job.site_id)
      .maybeSingle();
    // Si el SELECT falla, `existing` queda undefined y el guard se cae hacia adelante. Con el
    // reconcile incondicional de abajo eso ya no puede cobrar dos veces, pero se corta igual:
    // seguir a ciegas en el camino del dinero no aporta nada.
    if (errExisting) {
      throw new HandlerError(
        `clover payment: no se pudo leer el estado del pago en MCM (${errExisting.message})`,
        'CLOVER_PAYMENT_STATE_READ_FAILED', true,
      );
    }
    if (existing?.pos_id) {
      return { skipped: 'already_applied', clover_payment_id: existing.pos_id };
    }
  }

  // ── Ancla de reconciliación ────────────────────────────────────────────────────────────
  // `note` sobrevive el viaje de ida y vuelta (verificado contra el merchant). NO se usa
  // `externalPaymentId` porque la edge lo llena con `Invoice #: …`, que es un valor de
  // PRESENTACIÓN y no es único por pago.
  const anclaMcm = paymentId != null ? `mcm:pay:${job.site_id}:${paymentId}` : null;
  const cuerpo: Record<string, unknown> = anclaMcm
    ? { ...paymentBody, note: paymentBody['note'] ? `${paymentBody['note']} ${anclaMcm}` : anclaMcm }
    : { ...paymentBody };

  // ── RECONCILE-BEFORE-REPOST (H-N7) ─────────────────────────────────────────────────────
  // MEDIDO: Clover **ignora** `Idempotency-Key` en `/payments` — dos POST idénticos con la misma
  // clave crearon DOS pagos de $10 sobre la misma orden. El comentario que había aquí afirmaba lo
  // contrario y era la única protección que se creía tener aparte del guard por `pos_id`.
  //
  // El agujero: si el POST triunfa en Clover pero el proceso muere antes de escribir `pos_id`,
  // el reintento COBRA DOS VECES. Por eso se lee el estado real ANTES de postear.
  //
  // SE RECONCILIA SIEMPRE, no sólo cuando `attempt_count > 0`. La versión anterior gateaba con ese
  // contador y **dejaba pasar justo el escenario que este bloque existe para cerrar**: el contador
  // sólo lo incrementan `complete_step`/`fail_step`, y hay TRES caminos automáticos que lo devuelven
  // a cero — verificado contra las funciones vivas y `cron.job`:
  //   · `recover_stuck_jobs()` (cron cada MINUTO, activo) no toca `job_steps` en absoluto: el job
  //     vuelve a `retrying` con el contador intacto en 0.
  //   · `retry_dead_letter_job()` hace `update job_steps ... attempt_count = 0`.
  //   · `retry_transient_dead_letters()` (cron cada 5 MIN, activo) llama al anterior, y su filtro
  //     incluye `clover` y casa `%timeout%` — el error MÁS FRECUENTE de Clover en este sistema.
  //
  // La secuencia real: el pago se aplica en Clover → la respuesta expira → el cron de 5 minutos
  // reencola con el contador a 0 → sin este cambio, se postea otra vez. Reconciliar siempre cuesta
  // UN GET por inyección de pago; no hacerlo cuesta un cobro doble.
  //
  // Regla heredada de Omnivore y es la que importa: **si el GET falla, NO se postea**. Reintentar
  // más tarde es barato; cobrar dos veces, no.
  if (anclaMcm) {
    let pagosVivos: any[] = [];
    try {
      const { data } = await client.get<any>(`/orders/${encodeURIComponent(ticketId)}?expand=payments`);
      pagosVivos = data?.payments?.elements ?? [];
    } catch (err) {
      const he = mapCloverError(err, 'CLOVER_PAYMENT_RECONCILE_FAILED');
      // 404 → la orden NO existe. Se corta aquí y NO se postea: el POST iría al mismo id y daría
      // 404 igual, así que dejarlo pasar no gana nada y autoriza un POST sin verificar. Y el 404
      // no es sólo "no existe": un `ticket_id` con un carácter raro o una región mal resuelta
      // producen el mismo 404 sobre una orden que sí está viva y quizá ya pagada.
      // No retryable a propósito, y el mensaje NO casa con el filtro del cron de reintentos
      // (`%timeout%`, `%HTTP 50%`, `%HTTP 429%`), así que nadie lo resucita a ciegas.
      if (he.statusCode === 404) {
        const terminal = new HandlerError(
          `clover payment: la orden ${ticketId} no existe en Clover — no se aplica el pago`,
          'CLOVER_ORDER_NOT_FOUND', false, 404,
        );
        // Este bloque vive ANTES del try/catch de abajo, así que si no se escribe aquí el aviso
        // no lo escribe nadie: un pago que muere porque el ticket desapareció se quedaría sin
        // rastro para el mesero, que es justo lo que se viene a arreglar.
        await persistCloverPaymentIssue(job.site_id, orderId, paymentId, terminal);
        throw terminal;
      }
      // Se fuerza retryable: no saber si ya se cobro NUNCA puede degenerar en re-postear.
      throw new HandlerError(
        `clover payment: no se pudo leer el estado de los pagos antes de postear (${he.message})`,
        'CLOVER_PAYMENT_RECONCILE_FAILED', true,
      );
    }
    const yaAplicado = pagosVivos.find((pg: any) => notaLlevaAncla(pg?.note, anclaMcm));

    // El ancla identifica el pago; el IMPORTE confirma que es el mismo pago y no una versión
    // distinta del mismo id. `requeue_job(p_payload_override)` permite reencolar con otro importe,
    // y entonces el ancla coincide pero el dinero no. Adoptarlo daría por cobrado un importe que
    // nadie cobró; volver a postear cobraría dos veces. Ninguna de las dos: se para para revisión.
    // MEDIDO (H-N9) que Clover devuelve el `amount` EXACTO que se le envía, así que la comparación
    // es fiable y no va a bloquear pagos legítimos.
    const importeEsperado = Number((paymentBody as any)?.amount);
    if (yaAplicado?.id && Number.isFinite(importeEsperado) && Number(yaAplicado.amount) !== importeEsperado) {
      const desajuste = new HandlerError(
        `clover payment: el pago ${yaAplicado.id} lleva nuestra ancla pero su importe es ` +
        `${yaAplicado.amount} y se esperaba ${importeEsperado} — no se adopta ni se re-postea`,
        'CLOVER_PAYMENT_AMOUNT_MISMATCH', false,
      );
      // Terminal y fuera del try de abajo: sin esto, el caso que MÁS necesita ojos humanos
      // sería el único que no avisa a nadie.
      await persistCloverPaymentIssue(job.site_id, orderId, paymentId, desajuste);
      throw desajuste;
    }
    if (yaAplicado?.id) {
      const cloverPaymentId = String(yaAplicado.id);
      const { error: errAdop } = await supabase.from('payments').update({ pos_id: cloverPaymentId })
        .eq('id', paymentId).eq('site_id', job.site_id);
      if (errAdop) {
        throw new HandlerError(
          `clover payment: se reconcilió el pago ${cloverPaymentId} pero no se pudo registrar (${errAdop.message})`,
          'CLOVER_PAYMENT_PERSIST_FAILED', true,
        );
      }
      const { error: errMapaAdop } = await supabase.from('clover_payment_map').upsert(
        { site_id: job.site_id, clover_payment_id: cloverPaymentId, mcm_payment_id: paymentId,
          external_payment_id: externalPaymentId ?? null, voided: false },
        { onConflict: 'site_id,clover_payment_id', ignoreDuplicates: false });
      if (errMapaAdop) {
        throw new HandlerError(
          `clover payment: se reconcilió el pago ${cloverPaymentId} pero falló el mapa anti-bucle (${errMapaAdop.message})`,
          'CLOVER_PAYMENT_MAP_FAILED', true,
        );
      }
      await reconcileCloverOrderIssues(job.site_id, orderId, job.id);
      return { clover_payment_id: cloverPaymentId, reconciled: true };
    }
  }

  try {
    // La cabecera se mantiene por si Clover la implementa algún día, pero **NO es la
    // protección**: está medido que hoy la ignora. La protección es el bloque de arriba.
    const idempotencyHeader = paymentId != null
      ? { headers: { 'Idempotency-Key': `mcm-clover-pay-${job.site_id}-${paymentId}` } }
      : undefined;
    const res = await client.post<{ id: string }>(`/orders/${encodeURIComponent(ticketId)}/payments`, cuerpo, idempotencyHeader);
    const cloverPaymentId = res.data?.id ?? null;

    if (paymentId != null && cloverPaymentId) {
      // EL DINERO YA SE MOVIÓ. Si estas escrituras fallan y se descarta el error, el handler
      // devuelve éxito, `complete_step` cierra el job y `reencolarPagosHuerfanos` NO puede
      // recuperarlo, porque `enqueue_job` es `ON CONFLICT DO NOTHING` sobre
      // `clover_pay:{site}:{payment}`: el cobro existe en Clover y MCM no lo registra nunca,
      // sin error y sin dead-letter. Por eso se lanza y se reintenta.
      //
      // Reintentar es SEGURO precisamente por el reconcile incondicional de arriba: el siguiente
      // intento encuentra el pago por su ancla y lo adopta en vez de volver a cobrarlo.
      const { error: errPago } = await supabase
        .from('payments')
        .update({ pos_id: cloverPaymentId })
        .eq('id', paymentId)
        .eq('site_id', job.site_id);
      if (errPago) {
        throw new HandlerError(
          `clover payment: el pago ${cloverPaymentId} SÍ se aplicó en Clover pero no se pudo ` +
          `registrar en MCM (${errPago.message})`,
          'CLOVER_PAYMENT_PERSIST_FAILED', true,
        );
      }

      const { error: errMapa } = await supabase.from('clover_payment_map').upsert(
        {
          site_id: job.site_id,
          clover_payment_id: cloverPaymentId,
          mcm_payment_id: paymentId,
          external_payment_id: externalPaymentId ?? null,
          voided: false,
        },
        { onConflict: 'site_id,clover_payment_id', ignoreDuplicates: false }
      );
      if (errMapa) {
        throw new HandlerError(
          `clover payment: el pago ${cloverPaymentId} se aplicó y se registró, pero falló el mapa ` +
          `anti-bucle del pull (${errMapa.message})`,
          'CLOVER_PAYMENT_MAP_FAILED', true,
        );
      }
    }
    await reconcileCloverOrderIssues(job.site_id, orderId, job.id);
    return { clover_payment_id: cloverPaymentId };
  } catch (err) {
    const he = err instanceof HandlerError ? err : mapCloverError(err, 'CLOVER_PAYMENT_FAILED');
    if (willTerminate(he.retryable, step)) {
      // El fallo de PAGO va a `orders.issues`, que es la columna que lee la app del mesero
      // (`orderandpay`): sube la cuenta al tope, la marca y ofrece «Reintentar». Antes esto sólo
      // escribía `pos_injection_error`, que esa app no lee — o sea que un cobro que no entraba
      // era invisible para quien podía arreglarlo. Y de paso deja de pisar el error de inyección
      // de la orden, que comparte esa otra columna.
      await persistCloverPaymentIssue(job.site_id, orderId, paymentId, he);
    }
    throw he;
  }
});
