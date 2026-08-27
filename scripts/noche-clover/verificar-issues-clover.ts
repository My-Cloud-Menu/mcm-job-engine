/**
 * EN VIVO · el fallo de PAGO de Clover deja aviso donde lo ve el mesero, y se limpia solo.
 *
 * `orders.issues` es la columna que lee `orderandpay`: sube la cuenta al tope, la marca en rojo
 * y ofrece «Reintentar». Clover escribía todo en `pos_injection_error`, que esa app no lee — o
 * sea que un cobro que no entraba era invisible para quien podía arreglarlo.
 *
 * Sólo toca el banco 99990004 / merchant sandbox. Limpia lo que crea.
 */
import '../../src/handlers/clover/inject/payment';
import { getHandler } from '../../src/handlers/registry';
import { supabase } from '../../src/lib/supabase';

const SITE = 99990004;
const ok: string[] = [], mal: string[] = [];
const check = (n: string, c: boolean, d = '') => {
  (c ? ok : mal).push(n); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`);
};

const JOB_1 = crypto.randomUUID();
const JOB_2 = crypto.randomUUID();

const correr = (orderId: number, paymentId: number, ticketId: string, jobId = JOB_1) =>
  getHandler('clover', 'payment_injection')!({
    stepInput: {},
    jobPayload: { order_id: orderId, payment_id: paymentId, ticket_id: ticketId,
                  payment: { amount: 500, tender: { id: '4QPPVE0NFNBN4' } } },
    context: {},
    job: { id: jobId, site_id: SITE, correlation_id: 'ver' } as any,
    step: { idempotency_key: 'ver', attempt_count: 0, max_attempts: 1 } as any,
  } as any);

const leerOrden = async (id: number) => (await supabase.from('orders')
  .select('issues, pos_injection_error').eq('id', id).eq('site_id', SITE).maybeSingle()).data as any;

async function main() {
  // orden y pago de usar y tirar
  const { data: o } = await supabase.from('orders').insert({
    site_id: SITE, channel: 'pos', status: 'new-order', payment_status: 'not_fulfilled',
    currency: 'USD', line_items: [], subtotal: 5, total: 5, total_tax: 0, paid: 0,
    discount_total: 0, shipping_total: 0, fee_total: 0, additional_properties: {},
    date_created: new Date().toISOString(), date_updated: new Date().toISOString(),
  }).select('id').single();
  const orderId = Number((o as any).id);

  const { data: p } = await supabase.from('payments').insert({
    site_id: SITE, method: 'card', status: 'completed', source: 'pos',
    total: 5, tip: 0, orders_ids: [orderId], additional_properties: {},
  }).select('id').single();
  const paymentId = Number((p as any).id);
  console.log(`\norden ${orderId} · pago ${paymentId}\n`);

  // ── 1. fallo: la orden no existe en Clover (404 terminal, antes del POST) ──────
  try { await correr(orderId, paymentId, 'ORDENQUENOEXISTE'); } catch { /* esperado */ }
  const tras = await leerOrden(orderId);
  check('el fallo de pago escribe `issues`', tras?.issues != null);
  check('  … con provider clover', tras?.issues?.provider === 'clover');
  check('  … con el payment_id, que es el ancla del reintento', tras?.issues?.payment_id === paymentId);
  check('  … con un mensaje para una persona', typeof tras?.issues?.friendly_error === 'string'
        && !/HTTP_|axios|undefined/i.test(tras.issues.friendly_error), tras?.issues?.friendly_error);
  check('  … SIN el volcado crudo del POS', String(tras?.issues?.error ?? '').length < 500,
        `${String(tras?.issues?.error ?? '').length} chars`);
  check('NO pisa pos_injection_error (que es de la inyección de orden)', tras?.pos_injection_error == null);

  // ── 2. un pago que SÍ entra limpia el aviso ───────────────────────────────────
  //     Se simula el desenlace real: el pago queda aplicado y no hay hermanos pendientes.
  const { createCloverClient, CloverConfigSchema } = await import('../../src/handlers/clover/client');
  const { getSiteIntegrationConfig } = await import('../../src/lib/credentials');
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cfg = CloverConfigSchema.parse(config);
  const client = createCloverClient(cfg, 'ver', SITE);
  const { data: ord } = await client.post<any>('/orders', { state: 'open', title: 'VER issues' });
  await client.post(`/orders/${ord.id}/line_items`, { name: 'x', price: 500 });

  await correr(orderId, paymentId, ord.id, JOB_2);
  const tras2 = await leerOrden(orderId);
  check('un pago que entra LIMPIA el aviso', tras2?.issues == null,
        tras2?.issues ? JSON.stringify(tras2.issues).slice(0, 60) : 'null');

  // ── limpieza ──────────────────────────────────────────────────────────────────
  await supabase.from('clover_payment_map').delete().eq('site_id', SITE).eq('mcm_payment_id', paymentId);
  await supabase.from('payments').delete().eq('id', paymentId).eq('site_id', SITE);
  await supabase.from('orders').delete().eq('id', orderId).eq('site_id', SITE);
  try { await client.post(`/orders/${ord.id}`, { state: 'Deleted', title: 'VER issues — limpiada' }); } catch {}
  console.log('\n  limpieza hecha');

  console.log(`\nRESULTADO: ${ok.length} OK · ${mal.length} FALLAN`);
  process.exit(mal.length ? 1 : 0);
}
main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
