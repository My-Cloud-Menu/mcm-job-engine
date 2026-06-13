import { OMNI, omniTicket, sb, SITE_ID } from './harness';
const ORDERS = [10038, 10039, 10040];
const PROBE_TICKETS = ['20260612-1010007','20260612-1010008'];
(async () => {
  // Cerrar tickets Omnivore abiertos de las órdenes de prueba + probes
  const { data: rows } = await sb.from('orders').select('id,pos_id,table_id').in('id', ORDERS).eq('site_id', SITE_ID);
  const tickets = [...(rows??[]).map((r:any)=>r.pos_id).filter(Boolean), ...PROBE_TICKETS];
  for (const tid of tickets) {
    const t = await omniTicket(tid);
    if (t.open && (t.totals?.due ?? 0) > 0) {
      const { status } = await OMNI('POST', `/tickets/${tid}/payments`, { type:'3rd_party', amount: t.totals.due, tip:0, tender_type:'979', comment:'cleanup' }, `cleanup_pay:${tid}`);
      console.log(`close ${tid} due=${t.totals.due} → ${status}`);
    } else if (t.open) {
      console.log(`${tid} open due=0 (vacío, se deja)`);
    } else console.log(`${tid} ya cerrado`);
  }
  // Liberar mesas + borrar órdenes MCM de prueba
  const tableIds = (rows??[]).map((r:any)=>r.table_id).filter(Boolean);
  if (tableIds.length) await sb.from('floor_elements').update({ status:'available' }).in('id', tableIds).eq('site_id', SITE_ID);
  const del = await sb.from('orders').delete().in('id', ORDERS).eq('site_id', SITE_ID);
  console.log('deleted MCM test orders:', del.error ? del.error.message : 'ok');
  // Borrar el pago externo creado por el sync de 10040
  await sb.from('payments').delete().contains('orders_ids', [10040]).eq('site_id', SITE_ID);
  console.log('cleanup done');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
