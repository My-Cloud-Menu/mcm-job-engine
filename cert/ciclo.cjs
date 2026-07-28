const L=require('./lib.cjs');
const {omni,clover,db,CERT_SITE:S,sleep}=L;
/** Ciclo completo: mesero abre y firea -> sync -> push -> Flex cobra -> forward -> estado final. */
async function ciclo({tag,items,tip,table,payAmount}){
  const since=new Date().toISOString();
  const name=`CERT-${L.TOK}-${tag}`;
  const t=await omni.openTicket({name,table,guestCount:2});
  if(!t.ok) return {tag,fase:'open',error:JSON.stringify(t.body?.errors)};
  const tid=t.body.id;
  const add=await omni.addItems(tid,items.map(m=>({menu_item:m,quantity:1,auto_send:true})));
  if(!add.ok) return {tag,ticket:tid,fase:'add',error:JSON.stringify(add.body?.errors)};
  const tot=(await omni.ticket(tid)).body.totals;

  const r1=await db.syncUntil(S,'omnivore','fetch_recent_orders',()=>db.orderByOmnivore(S,tid),{maxCycles:4});
  const mcm=r1.got;
  if(!mcm) return {tag,ticket:tid,fase:'sync',error:`no llegó a MCM tras ${r1.cycles} ciclos`,cheque_total:tot.total};

  const r2=await db.syncUntil(S,'clover','push_orders',
    async()=>{const o=await db.order(S,mcm.id);return o?.clover_ticket_id&&!/^(pending|syncing)/.test(o.clover_ticket_id)?o:null;},{maxCycles:4});
  const m2=r2.got;
  if(!m2) return {tag,ticket:tid,mcm:mcm.id,fase:'push',error:'no llegó a Clover',cheque_total:tot.total};

  const amt = payAmount ?? tot.total;
  const pay=await clover.pay(m2.clover_ticket_id,{amount:amt,tip,externalPaymentId:`CERT-${L.TOK}-${tag}`});
  if(pay.status>=300) return {tag,ticket:tid,mcm:mcm.id,clover:m2.clover_ticket_id,fase:'pay',error:JSON.stringify(pay.body)};

  const r3=await db.syncUntil(S,'clover','fetch_payments',
    async()=>{const ps=await db.payments(S,mcm.id);return ps.find(p=>p.pos_id===pay.body.id)||null;},{maxCycles:4});
  const mcmPay=r3.got;

  let inj=null;
  for(let i=0;i<25;i++){await sleep(3000);
    const js=await db.jobs(S,since);
    inj=js.find(x=>x.job_type==='payment_injection'&&x.integration==='omnivore'
      && (x.payload?.payment_id==null || String(x.payload?.payment_id)===String(mcmPay?.id)));
    if(inj&&['completed','dead_letter'].includes(inj.status))break;}
  await sleep(3000);
  const tf=await omni.ticket(tid);
  const pf=mcmPay?await db.payments(S,mcm.id):[];
  return {tag,ticket:tid,mcm:mcm.id,clover:m2.clover_ticket_id,
    cheque_total:tot.total, tip_cobrado:tip, pago_enviado_a_clover:amt, clover_pay:pay.body?.id,
    mcm_pay_total:mcmPay?.total, mcm_pay_tip:mcmPay?.tip,
    enviado_amount:inj?.payload?.payment?.amount, enviado_tip:inj?.payload?.payment?.tip,
    job:inj?.status, idem:inj?.idempotency_key, error:inj?.last_error?.slice(0,90),
    omni_pay_id:pf.find(p=>p.pos_id===pay.body?.id)?.additional_properties?.omnivore_payment_id||null,
    due_final:tf.body?.totals?.due, paid_final:tf.body?.totals?.paid, tips_final:tf.body?.totals?.tips,
    open_final:tf.body?.open};
}
module.exports={ciclo};
