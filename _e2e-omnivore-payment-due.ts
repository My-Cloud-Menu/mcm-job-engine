// E2E del MOTOR sobre el banco (site 25612612), SIN worker en la cola: llama al handler `payment_injection`
// (código nuevo) directamente contra el caso REAL del incidente 10614: pago 10483 (amount 14536) sobre el
// ticket 20260918-20003 (due 14487, abierto, 0 tenders). Esperado: se postea el DUE, la mesa cierra en Aloha,
// marca jsonb + ajuste en el pago, nota de sistema en order_notes, salida `adjusted: true`.
// Uso (cwd = mcm-job-engine): npx tsx _e2e-omnivore-payment-due.ts [--payment 10483 --order 10614 --ticket 20260918-20003 --job b5fa31e5-43ff-428f-be3e-5b45ee4e57ce]
import './src/config';
import './src/handlers/omnivore/inject/payment';
import { getHandler } from './src/handlers/registry';
import { getSiteIntegrationConfig } from './src/lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from './src/handlers/omnivore/client';
import { supabase } from './src/lib/supabase';
import { writeFileSync } from 'node:fs';

const SITE_ID = 25612612;
const args = process.argv.slice(2);
const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const paymentId = Number(arg('--payment', '10483'));
const orderId = Number(arg('--order', '10614'));
const ticketId = arg('--ticket', '20260918-20003');
const jobId = arg('--job', 'b5fa31e5-43ff-428f-be3e-5b45ee4e57ce');

async function main() {
  const rec: any = { t0: new Date().toISOString(), site_id: SITE_ID, payment_id: paymentId, order_id: orderId, ticket_id: ticketId };
  const { config } = await getSiteIntegrationConfig(SITE_ID, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), 'e2e-due');
  const ticket = async () => (await client.get(`/tickets/${ticketId}`, { params: { fields: 'open,totals(total,due,paid),payments(id,amount,tip)' } })).data;
  const paymentRow = async () => (await supabase.from('payments').select('id,total,tip,pos_id,pos_request_payload,additional_properties').eq('site_id', SITE_ID).eq('id', paymentId).single()).data as any;
  const notes = async () => (await supabase.from('order_notes').select('content,is_system,created_at').eq('site_id', SITE_ID).eq('order_id', orderId).order('created_at')).data ?? [];
  const before = await ticket(); const pBefore = await paymentRow();
  rec.before = { ticket: { open: before?.open, ...before?.totals, tenders: before?._embedded?.payments ?? [] }, payment: pBefore, notes: (await notes()).length };
  const payment = pBefore?.pos_request_payload;
  if (!payment || typeof payment.amount !== 'number') throw new Error('el pago no tiene pos_request_payload congelado');
  console.log('ANTES:', JSON.stringify(rec.before.ticket), '| pago', JSON.stringify({ total: pBefore.total, tip: pBefore.tip, pos_id: pBefore.pos_id, marker: pBefore.additional_properties?.omnivore_payment_id, amount: payment.amount }));
  const handler = getHandler('omnivore', 'payment_injection')!;
  const job: any = { id: jobId, site_id: SITE_ID, correlation_id: 'e2e-due', integration: 'omnivore', queue_name: 'pos_injection', job_type: 'payment_injection', payload: {} };
  const step: any = { id: 'e2e-step', idempotency_key: `pos_pay:omnivore:${SITE_ID}:${paymentId}:e2e`, attempt_count: 0, max_attempts: 5 };
  let out: any, err: any = null;
  try {
    out = await handler({ stepInput: {}, jobPayload: { payment_id: paymentId, order_id: orderId, ticket_id: ticketId, payment }, context: {}, job, step });
  } catch (e: any) { err = { code: e?.code, message: e?.message, retryable: e?.retryable, body: e?.responseBody }; }
  rec.handler = { out, err };
  const after = await ticket(); const pAfter = await paymentRow(); const n = await notes();
  rec.after = { ticket: { open: after?.open, ...after?.totals, tenders: after?._embedded?.payments ?? [] }, payment: { total: pAfter?.total, tip: pAfter?.tip, pos_id: pAfter?.pos_id, additional_properties: pAfter?.additional_properties }, notes: n };
  console.log('HANDLER:', JSON.stringify(out ?? err));
  console.log('DESPUÉS:', JSON.stringify(rec.after.ticket), '| pago', JSON.stringify(rec.after.payment), '| notas', n.length, n.length ? JSON.stringify(n[n.length - 1].content) : '');
  const file = `../mcm-edge-functions/audits/2026-09-18-omnivore-fire-before-pay/evidencia/motor-payment-due-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(rec, null, 1)); console.log('evidencia →', file);
  process.exit(err ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
