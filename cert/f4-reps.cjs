const L=require('./lib.cjs');
const {omni,clover,db,CERT_SITE:S,sleep,saveEvidence,TOK}=L;
async function ciclo({tag,items,tip,table}){
  const since=new Date().toISOString();
  const name=`CERT-${TOK}-${tag}`;
  const t=await omni.openTicket({name,table,guestCount:2});
  if(!t.ok) return {tag,error:'open',body:t.body};
  const tid=t.body.id;
  await omni.addItems(tid,items.map(m=>({menu_item:m,quantity:1,auto_send:true})));
  const tk=await omni.ticket(tid); const tot=tk.body.totals;
  await db.syncNow(S,'omnivore','fetch_recent_orders',180000);
  const mcm=await db.orderByOmnivore(S,tid);
  if(!mcm) return {tag,error:'no llegó a MCM',ticket:tid};
  await db.syncNow(S,'clover','push_orders',120000);
  let m2=null; for(let i=0;i<20;i++){await sleep(3000); m2=await db.order(S,mcm.id); if(m2?.clover_ticket_id)break;}
  if(!m2?.clover_ticket_id) return {tag,error:'no llegó a Clover',ticket:tid,mcm:mcm.id};
  const due=tot.total;
  const pay=await clover.pay(m2.clover_ticket_id,{amount:due,tip,externalPaymentId:`CERT-${TOK}-${tag}`});
  await db.syncNow(S,'clover','fetch_payments',120000);
  let inj=null; for(let i=0;i<25;i++){await sleep(3000);
    const js=await db.jobs(S,since);
    inj=js.find(x=>x.job_type==='payment_injection'&&x.integration==='omnivore');
    if(inj&&['completed','dead_letter'].includes(inj.status))break;}
  await sleep(3000);
  const tf=await omni.ticket(tid);
  return {tag,ticket:tid,mcm:mcm.id,clover:m2.clover_ticket_id,
    cheque_total:due, tip_cobrado:tip, clover_pay:pay.body?.id,
    enviado_amount:inj?.payload?.payment?.amount, enviado_tip:inj?.payload?.payment?.tip,
    job:inj?.status, error:inj?.last_error?.slice(0,80),
    due_final:tf.body?.totals?.due, paid_final:tf.body?.totals?.paid, tips_final:tf.body?.totals?.tips,
    open_final:tf.body?.open};
}
(async()=>{
  const casos=[
    {tag:'R2',items:['300155','300110'],tip:250,table:'107'},          // $5+$6 con propina
    {tag:'R3',items:['300025','310170'],tip:475,table:'108'},          // $13+$9 con propina
    {tag:'C0',items:['300015'],tip:0,table:'109'},                     // CONTROL sin propina
  ];
  const out=[];
  for(const c of casos){ const r=await ciclo(c); out.push(r);
    console.log(`\n── ${r.tag}  ticket=${r.ticket}  cheque=${r.cheque_total}  propina=${r.tip_cobrado}`);
    console.log(`   enviado a Omnivore: amount=${r.enviado_amount} tip=${r.enviado_tip}   job=${r.job}`);
    if(r.error) console.log(`   error: ${r.error}`);
    console.log(`   cheque final: due=${r.due_final} paid=${r.paid_final} tips=${r.tips_final} open=${r.open_final}`);
    const esperado=r.cheque_total-(r.tip_cobrado||0);
    console.log(`   ¿doble resta? enviado ${r.enviado_amount} vs cheque ${r.cheque_total} -> ${r.enviado_amount===esperado&&r.tip_cobrado>0?'SÍ':(r.tip_cobrado===0?'n/a (sin propina)':'no')}`);
  }
  console.log('\n══ RESUMEN ══');
  out.forEach(r=>console.log(`  ${r.tag}: propina=${r.tip_cobrado} enviado=${r.enviado_amount}/${r.cheque_total} job=${r.job} due_final=${r.due_final} open=${r.open_final}`));
  saveEvidence(`f4-reps-${TOK}`,out);
  await db.close();
})();
