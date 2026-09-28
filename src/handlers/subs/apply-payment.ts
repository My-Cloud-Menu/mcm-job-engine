import { z } from 'zod';
import { registerHandler } from '../registry';
import { HandlerError } from '../../core/types';
import { logger } from '../../lib/logger';
import {
  loadPayment, loadOrders, loadSettings, loadPublishedTerms,
  existingUnitsForOrder, customerIdByAccountEmail, demoteOtherDefaults, upsertInstrument, attachInstrumentToOrder,
  insertSubscription, insertFirstPeriod, logEvents, enqueueSubsJob, descuentoRecurrenteDeLaOrden, equipoActivable, activarEquipo, avisarEquipoActivado,
  cerrarOrdenSoloPlanes } from './repo';
import { existingUnitKeys, isCardMethod, testCardInstrument, unitKey } from './apply-payment-rules';

// subs.apply_payment — convierte un pago completado en suscripciones.
//
// Lo encola el observador `trg_subs_on_payment_completed` (un trigger del MÓDULO sobre `payments`);
// el núcleo no conoce este handler ni lo espera. Si esto falla, el cobro ya pasó igual.
//
// Dos reglas de negocio que se ven aquí:
//   · La suscripción nace en `pending_activation` y **SIN vencimiento**: el reloj arranca cuando el
//     cliente activa su equipo, no cuando paga. Un plan comprado y guardado en un cajón no se
//     consume solo.
//   · El precio se CONGELA (`locked_unit_price`) con el de la línea. Si el motor leyera el catálogo
//     en cada renovación, subir la tarifa re-tarificaría en silencio a los suscriptores vivos.

const Input = z.object({ payment_id: z.number(), site_id: z.number() });

/** Una línea casa con un término si coinciden producto Y variación. `""` y null son la misma cosa. */
const mismaVariacion = (a: unknown, b: unknown) => (String(a ?? '') === String(b ?? ''));

registerHandler('subs', 'apply_payment', async ({ jobPayload }) => {
  const { payment_id, site_id } = Input.parse(jobPayload);

  const settings = await loadSettings(site_id);
  if (!settings || !settings.is_enabled) return { skipped: 'module_not_enabled' };

  const payment = await loadPayment(payment_id, site_id);
  if (!payment) throw new HandlerError(`pago ${payment_id}/${site_id} no encontrado`, 'SUBS_PAYMENT_NOT_FOUND', false);
  // No es un error: el pago pudo revertirse entre el encolado y el proceso.
  if (payment.status !== 'completed') return { skipped: 'payment_not_completed', status: payment.status };

  const orderIds = (payment.orders_ids ?? []).map(Number).filter(Number.isFinite);
  if (orderIds.length === 0) return { skipped: 'payment_without_orders' };

  // El cobro de una RENOVACION no compra nada: ya hay suscripcion. Su orden lleva una linea de plan
  // igual que una compra, asi que sin esta guarda se crearia una suscripcion nueva en cada cobro
  // mensual — duplicando lo cobrado y el equipo. Hoy no es alcanzable (el observador es AFTER
  // UPDATE y esos pagos nacen ya `completed`), pero es una valla de un `if`.
  if ((payment as any)?.additional_properties?.subs?.period_id) {
    return { skipped: 'renewal_payment', period_id: (payment as any).additional_properties.subs.period_id };
  }

  const [orders, terms] = await Promise.all([
    loadOrders(orderIds, site_id),
    loadPublishedTerms(site_id),
  ]);
  if (terms.length === 0) return { skipped: 'no_published_terms' };

  const creadas: string[] = [];
  const dueñosPorOrden = new Map<number, string>();
  const eventos: Record<string, unknown>[] = [];
  let conSuscripcion = 0;

  for (const order of orders) {
    // Segunda valla, por si el pago no lleva la marca pero la orden sí.
    if ((order as any)?.additional_properties?.subs?.period_id) { conSuscripcion++; continue; }

    // IDEMPOTENCIA POR UNIDAD (R2): se crean sólo las (línea, unidad) que falten. El reintento de un job (o que el
    // mismo pago se complete dos veces) no duplica, y una caída a mitad de una flota no deja planes pagados sin crear.
    const existentes = existingUnitKeys(await existingUnitsForOrder(site_id, order.id));
    if (existentes.legacy) { conSuscripcion += existentes.keys.size || 1; continue; }

    const cliente = order.customer ?? {};
    const claimEmail = String((cliente as any).email ?? '').trim().toLowerCase() || null;
    const claimPhone = String((cliente as any).phone_e164 ?? (cliente as any).phone ?? '').trim() || null;
    // Si el CRM ya vinculo la orden a una ficha, la suscripcion nace CON dueño. El reclamo por
    // correo/telefono sigue existiendo para quien compra sin que el CRM resuelva nada, pero atarla
    // aqui evita el caso que se midio de verdad: comprar como invitado, entrar al portal y no ver
    // nada porque la suscripcion seguia sin `customer_id` hasta registrarse.
    // R8: si el email del checkout ya tiene CUENTA, la suscripción es de esa cuenta (así la ve quien entra con su
    // email); si no, de la ficha CRM del teléfono, como siempre.
    const cuentaDelEmail = claimEmail ? await customerIdByAccountEmail(site_id, claimEmail) : null;
    const dueño = cuentaDelEmail ?? order.crm_customer_id ?? null;
    if (dueño) dueñosPorOrden.set(order.id, dueño);

    // Descuento RECURRENTE heredado del cupón de la compra, si su término dura más de un ciclo.
    // Se congela en la suscripción por el mismo motivo que `locked_unit_price`: si el motor releyera
    // el cupón en cada ciclo, editarlo re-tarificaría en silencio a todos los suscriptores vivos.
    // Se resuelve UNA vez por orden — no por línea — porque el cupón es del carrito, no del artículo.
    const descuento = await descuentoRecurrenteDeLaOrden(site_id, order.id);

    // ¿La compra dice PARA QUÉ EQUIPO es? Es el «flujo c»: el cliente ya tiene el aparato
    // registrado y contrata el plan desde su ficha. Pedirle después «activa tu equipo» sería
    // pedirle un paso que YA hizo — nos dijo cuál es al comprar.
    const assetPedido = String(
      (order.additional_properties as Record<string, unknown> | null | undefined)
        ?.['subs' as never]?.['asset_id' as never] ?? '',
    ).trim() || null;

    // Se comprueba contra la base: existe, es suyo y no tiene ya un plan vivo. El id lo manda el
    // navegador, así que no se cree por venir en el cuerpo.
    let equipo = assetPedido ? await equipoActivable(site_id, assetPedido, dueño) : null;
    // Pidió un equipo y no se le puede atar (no es de este dueño, ya tiene plan vivo, retirado): el plan nace `pending_activation`
    // como siempre, pero queda RASTRO para revisarlo — nunca en silencio (revisión F5 #2).
    if (assetPedido && !equipo) {
      eventos.push({ site_id, kind: 'flow_c_not_attached', actor: 'job:subs.apply_payment', customer_id: dueño,
        payload: { order_id: order.id, payment_id: payment.id, asset_id: assetPedido } });
    }

    for (const [lineIdx, li] of (order.line_items ?? []).entries()) {
      const term = terms.find(
        (t) => Number(t.product_id) === Number(li?.product_id) &&
               mismaVariacion(t.variation_id, li?.variation_id),
      );
      if (!term) continue;

      const precio = Number(li?.price ?? li?.product_price ?? 0);
      if (!Number.isFinite(precio) || precio <= 0) {
        logger.warn({ site_id, order_id: order.id, product_id: li?.product_id },
                    'subs.apply_payment: linea de plan sin precio utilizable, se omite');
        continue;
      }

      // Cobro automático sólo si el negocio lo permite para esa cadencia Y el pago fue con tarjeta.
      // En efectivo o ATH Móvil no hay nada que guardar, así que la renovación es manual por fuerza.
      const cadenciaAutomatizable = term.interval_count <= settings.auto_collection_max_interval_months;
      const conTarjeta = isCardMethod(payment.method);
      const collection = (cadenciaAutomatizable && conTarjeta) ? 'auto' : 'manual';

      // `quantity` unidades = `quantity` suscripciones: dos equipos comprados juntos son dos planes.
      const unidades = Math.max(1, Math.floor(Number(li?.quantity ?? 1)));
      const lineaId = li?.id ?? `idx-${lineIdx}`;
      for (let i = 0; i < unidades; i++) {
        if (existentes.keys.has(unitKey(lineaId, i))) { conSuscripcion++; continue; }
        const subId = await insertSubscription({
          site_id,
          plan_term_id: term.id,
          status: 'pending_activation',
          collection,
          locked_unit_price: precio,
          // Con equipo declarado, el plan nace ACTIVO y el reloj arranca AL PAGAR: el aparato ya
          // está en su cuenta y funcionando, no hay nada que esperar. Sin él, `pending_activation`
          // y el reloj espera a la activación, que es el caso de la compra normal.
          ...(equipo ? {
            status: 'active' as const,
            asset_id: equipo.id,
            activated_at: new Date().toISOString(),
            current_period_start: new Date().toISOString(),
            current_period_end: finDelCiclo(term.interval_unit, term.interval_count),
          } : {}),
          ...(descuento ? {
            discount_kind: descuento.kind,
            discount_value: descuento.value,
            discount_cycles_left: descuento.cyclesLeft, // null = para siempre
            discount_coupon_id: descuento.couponId,
            discount_code: descuento.code,
          } : {}),
          // SIN current_period_end a propósito: el reloj arranca al ACTIVAR el equipo.
          ...(dueño ? { customer_id: dueño } : {}),
          claim_email: claimEmail,
          claim_phone_e164: claimPhone,
          source_order_id: order.id,
          metadata: { line_item_id: lineaId, unit_index: i },
        });
        if (!subId) continue;
        creadas.push(subId);

        await insertFirstPeriod({
          site_id,
          subscription_id: subId,
          seq: 1,
          period_start: new Date().toISOString(),
          // Con equipo, el ciclo 1 ya tiene su fin de verdad. Sin él queda abierto hasta la
          // activación y aquí sólo hay que respetar el CHECK `period_end > period_start`.
          period_end: equipo
            ? finDelCiclo(term.interval_unit, term.interval_count)
            : new Date(Date.now() + 86_400_000).toISOString(),
          amount: precio,
          status: 'paid',
          order_id: order.id,
          payment_id: payment.id,
          paid_at: new Date().toISOString(),
        });

        const nacioActiva = !!equipo;
        if (equipo) {
          await activarEquipo(site_id, equipo.id);
          if (dueño) {
            const idioma = (order.additional_properties as { store?: { locale?: string } } | null | undefined)?.store?.locale === 'en' ? 'en' : 'es';
            await avisarEquipoActivado(site_id, subId, dueño, equipo.id, finDelCiclo(term.interval_unit, term.interval_count), idioma);
          }
          equipo = null;   // un equipo, un plan: la siguiente unidad vuelve a `pending_activation`
        }

        eventos.push({
          site_id, subscription_id: subId, kind: 'purchased', actor: `job:subs.apply_payment`,
          to_status: nacioActiva ? 'active' : 'pending_activation',
          payload: { order_id: order.id, payment_id: payment.id, term_code: term.code, price: precio },
        });
      }
    }
  }

  // Órdenes SÓLO de planes (D-054): nada que entregar → se cierran, SI el negocio lo pide (`config.close_plan_only_orders`; así
  // otro negocio con planes que sí se atienden en persona sigue como estaba). Con TODAS sus líneas reconocidas como plan del
  // negocio; una orden con un equipo o un accesorio sigue su camino normal (recoger/enviar).
  const cerrarSoloPlanes = (settings.config as Record<string, unknown> | null | undefined)?.close_plan_only_orders === true;
  for (const order of cerrarSoloPlanes ? orders : []) {
    const lineas = order.line_items ?? [];
    const soloPlanes = lineas.length > 0 && lineas.every((li) => terms.some(
      (t) => Number(t.product_id) === Number(li?.product_id) && mismaVariacion(t.variation_id, li?.variation_id)));
    if (soloPlanes && await cerrarOrdenSoloPlanes(site_id, order.id)) {
      eventos.push({ site_id, kind: 'order_closed_plan_only', actor: 'job:subs.apply_payment', payload: { order_id: order.id, payment_id: payment.id } });
    }
  }

  await logEvents(eventos);

  // Test Card (R1): la tarjeta ya la validó `test-card-confirm` y viene en el pago; se guarda aquí mismo (no hay
  // pasarela que consultar) y se liga a las suscripciones automáticas de cada orden.
  // Van ANTES de la salida temprana: si un intento anterior creó los planes y se cayó antes de guardar la tarjeta,
  // el reintento (que ya no crea nada) tiene que guardarla igual. Las dos operaciones son idempotentes.
  const hayPlanes = creadas.length > 0 || conSuscripcion > 0;
  if (hayPlanes && String(payment.method ?? '') === 'test_card') {
    const inst = testCardInstrument((payment as any)?.additional_properties?.test_card_instrument);
    for (const order of orders) {
      const dueño = dueñosPorOrden.get(order.id);
      if (!inst || !dueño) continue;
      await demoteOtherDefaults(site_id, dueño, inst.provider_pm_id);
      const instrumentId = await upsertInstrument({ site_id, customer_id: dueño, ...inst, status: 'active', is_default: true });
      if (instrumentId) await attachInstrumentToOrder(site_id, order.id, instrumentId);
    }
  }

  // Si el negocio pidió guardar la tarjeta, la cosecha va en un job APARTE: son dos llamadas a
  // Stripe y no deben retrasar (ni poder tumbar) la creación de la suscripción ya cobrada.
  const sessionId = payment.data?.checkout_session_id ?? payment.data?.id
    ?? payment.additional_properties?.checkout_session_id ?? null;
  if (hayPlanes && sessionId && String(payment.method ?? '').toLowerCase().includes('stripe')) {
    await enqueueSubsJob({
      siteId: site_id,
      jobType: 'subs.harvest_instrument',
      idempotencyKey: `subs:harvest:${site_id}:${payment.id}`,
      payload: { site_id, payment_id: payment.id, checkout_session_id: String(sessionId) },
      steps: [{ step_name: 'harvest_instrument' }],
      referenceType: 'payment', referenceId: String(payment.id),
    });
  }

  if (creadas.length === 0) {
    return conSuscripcion > 0
      ? { skipped: 'already_applied', existentes: conSuscripcion }
      : { skipped: 'no_subscription_lines' };
  }

  return { created: creadas.length, subscriptions: creadas };
});

/** Fin del primer ciclo a partir de la cadencia del término. */
function finDelCiclo(unidad: string, n: number): string {
  const d = new Date();
  const k = Math.max(1, Number(n) || 1);
  if (unidad === 'day') d.setDate(d.getDate() + k);
  else if (unidad === 'week') d.setDate(d.getDate() + 7 * k);
  else if (unidad === 'year') d.setFullYear(d.getFullYear() + k);
  else d.setMonth(d.getMonth() + k);
  return d.toISOString();
}
