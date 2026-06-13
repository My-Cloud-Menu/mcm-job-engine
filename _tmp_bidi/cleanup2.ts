import { OMNI, omniTicket, sb, SITE_ID } from './harness';
(async () => {
  // managed orders abiertos de prueba (no hay tráfico real en este site Dev)
  const { data: rows } = await sb.from('orders')
    .select('id,pos_id,table_id,status')
    .eq('site_id', SITE_ID)
    .in('status', ['new-order','in-kitchen'])
    .not('omnivore_pos_id','is',null);
  console.log(`abiertos a limpiar: ${rows?.length ?? 0}`);
  for (const r of rows ?? []) {
    const tid = (r as any).pos_id;
    if (tid) {
      try { const t = await omniTicket(tid);
        if (t.open && (t.totals?.due ?? 0) > 0) {
          const { status } = await OMNI('POST', `/tickets/${tid}/payments`, { type:'3rd_party', amount: t.totals.due, tip:0, tender_type:'979', comment:'cleanup' }, `cl2:${tid}`);
          console.log(`  close ${tid} → ${status}`);
        }
      } catch(e:any){ console.log(`  ${tid} close skip (${e?.code})`); }
    }
  }
  const tableIds = (rows ?? []).map((r:any)=>r.table_id).filter(Boolean);
  if (tableIds.length) await sb.from('floor_elements').update({ status:'available' }).in('id', tableIds).eq('site_id', SITE_ID);
  const ids = (rows ?? []).map((r:any)=>r.id);
  if (ids.length) { await sb.from('payments').delete().overlaps('orders_ids', ids).eq('site_id', SITE_ID); await sb.from('orders').delete().in('id', ids).eq('site_id', SITE_ID); }
  console.log(`borradas ${ids.length} órdenes de prueba, mesas liberadas`);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
