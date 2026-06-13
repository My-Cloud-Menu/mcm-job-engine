/* eslint-disable */
// ESCENARIO PAGO (Omnivore→MCM): cerrar/pagar el ticket en Omnivore -> sync -> MCM check-closed + pago externo.
import { OMNI, omniTicket, mcmOrder, snap, syncOnce, sb, SITE_ID } from './harness';

const ORDER_ID = Number(process.env.ORDER_ID || 10040);
const TICKET_ID = process.env.TICKET_ID || '20260612-1010006';

(async () => {
  console.log('============ ESCENARIO PAGO (Omnivore→MCM) ============');
  await snap('0. Estado pre-pago', ORDER_ID, TICKET_ID);

  // 1. Pagar el due completo en Omnivore (tender 979, 3rd_party) → cierra el ticket
  const t = await omniTicket(TICKET_ID);
  const due = t.totals?.due ?? 0;
  console.log(`   Pagando due=${due} cents en Omnivore...`);
  const { status, d } = await OMNI('POST', `/tickets/${TICKET_ID}/payments`,
    { type: '3rd_party', amount: due, tip: 0, tender_type: '979', comment: 'TEST pay close' },
    `test_pay:${TICKET_ID}`);
  console.log(`   pay status=${status}`, status >= 300 ? JSON.stringify(d?.errors ?? d).slice(0, 300) : `paid ok (payment id=${d?.id})`);

  const t2 = await omniTicket(TICKET_ID);
  console.log(`   Omnivore tras pago: open=${t2.open} due=${t2.totals?.due} paid=${t2.totals?.paid}`);

  // 2. Sync → MCM
  console.log('   sync:', JSON.stringify(await syncOnce(SITE_ID)));
  await snap('1. Tras sync (MCM debe quedar check-closed + paid)', ORDER_ID, TICKET_ID);

  // 3. ¿Se registró el pago externo en payments?
  const { data: pays } = await sb.from('payments').select('id,total,tip,status,method,source,reference,additional_properties').contains('orders_ids', [ORDER_ID]).eq('site_id', SITE_ID);
  console.log(`   payments rows for order ${ORDER_ID}:`, JSON.stringify(pays));
  process.exit(0);
})().catch((e) => { console.error('SCENARIO ERR', e); process.exit(1); });
