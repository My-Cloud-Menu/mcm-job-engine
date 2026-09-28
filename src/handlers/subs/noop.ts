import { registerHandler } from '../registry';

/**
 * subs.noop — handler de humo de la cola `billing`.
 *
 * Existe para poder verificar de punta a punta, en la fase 2 del módulo de Suscripciones, que la
 * cola, el contenedor y el registro de handlers funcionan ANTES de que exista un solo cobro. Sin
 * él, un worker que no arranca deja los jobs en `pending` sin un solo error — exactamente la clase
 * de fallo mudo que el módulo intenta evitar.
 *
 * Los handlers de verdad (subs.apply_payment, subs.invoice_period, subs.charge_period,
 * subs.dunning_advance, subs.harvest_instrument, subs.dispatch_notifications, subs.reconcile,
 * subs.external_sync) llegan en las fases 3-8.
 */
registerHandler('subs', 'noop', async ({ jobPayload }) => {
  return { ok: true, echo: jobPayload ?? null, at: new Date().toISOString() };
});
