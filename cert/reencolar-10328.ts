/**
 * Reencola el reenvío a Omnivore del pago de la orden 10328 (site 99990003), que se
 * perdió por H2: su llave `pos_pay:omnivore:10246` la ocupaba un job del site 48372619
 * desde el 10 de junio, así que `enqueue_job` devolvió el job ajeno y nunca se creó el
 * propio. Con el arreglo la llave pasa a `pos_pay:omnivore:99990003:10246`.
 *
 * Usa los MISMOS helpers de producción — no reimplementa nada.
 * Acotado a site_id=99990003 y al pago 10246.
 */
import 'dotenv/config';
import { supabase } from '../src/lib/supabase';
import { getSiteIntegrationConfig } from '../src/lib/credentials';
import { buildOmnivorePaymentBody } from '../src/handlers/omnivore/inject/build-payment-body';
import { enqueuePaymentInjection } from '../src/enqueue/helpers';

const SITE = 99990003;
const ORDER_ID = 10328;
const PAYMENT_ID = 10246;

(async () => {
  const { data: order } = await supabase
    .from('orders').select('id, pos_id, total, paid, payment_status, additional_properties')
    .eq('site_id', SITE).eq('id', ORDER_ID).maybeSingle();
  if (!order?.pos_id) { console.log('✗ la orden no existe o no tiene ticket de Omnivore'); return; }

  const { data: pay } = await supabase
    .from('payments').select('id, total, tip, source, reference, additional_properties')
    .eq('site_id', SITE).eq('id', PAYMENT_ID).maybeSingle();
  if (!pay) { console.log('✗ el pago no existe'); return; }

  const yaAplicado = (pay.additional_properties as any)?.omnivore_payment_id;
  console.log(`orden ${ORDER_ID} · ticket ${order.pos_id} · total ${order.total}`);
  console.log(`pago  ${PAYMENT_ID} · $${pay.total} · propina $${pay.tip}`);
  console.log(`ya aplicado a Omnivore: ${yaAplicado ?? 'NO'}`);
  if (yaAplicado) { console.log('→ nada que hacer, ya está aplicado'); return; }

  const { config } = await getSiteIntegrationConfig(SITE, 'omnivore', 'pos');
  const body = buildOmnivorePaymentBody(
    { id: pay.id, total: pay.total, tip: pay.tip, source: pay.source, method: 'ecr-card', reference: pay.reference } as any,
    config,
    (order.additional_properties as any)?.omnivore_managed === true,
  );
  console.log(`payload a enviar: ${JSON.stringify(body)}`);

  const jobId = await enqueuePaymentInjection({
    siteId: SITE,
    paymentId: PAYMENT_ID,
    orderId: ORDER_ID,
    ticketId: order.pos_id as string,
    posProvider: 'omnivore',
    payment: body,
    posIdField: 'additional_properties.omnivore_payment_id',
    maxAttempts: 4,
  });
  console.log(`\n✓ job encolado: ${jobId}`);

  // Confirmar que la llave nueva es la propia y no la ajena
  const { data: job } = await supabase
    .from('integration_jobs').select('id, site_id, idempotency_key, status')
    .eq('id', jobId).maybeSingle();
  console.log(`   llave: ${job?.idempotency_key}`);
  console.log(`   site del job: ${job?.site_id} ${Number(job?.site_id) === SITE ? '✓ es el propio' : '✗ ES AJENO'}`);
})();
