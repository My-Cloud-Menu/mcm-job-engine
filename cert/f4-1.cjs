const L=require('./lib.cjs');
const {omni,clover,db,CERT_SITE:S,sleep,saveEvidence,TOK}=L;
const els=x=>Array.isArray(x)?x:(x?.elements||[]);
(async()=>{
  const TICKET='20260726-1010001', CLOVER='CRV219DTMBHX8', MCM=10036;
  const TIP=300;
  const ev={caso:'F4.1 — reenvío del pago con propina (M1)',ticket:TICKET,clover:CLOVER,mcm:MCM,tip_cents:TIP};
  const since=new Date().toISOString();

  const t0=await omni.ticket(TICKET); ev.omnivore_antes=t0.body?.totals;
  console.log(`\n═══ F4.1 · propina de $${(TIP/100).toFixed(2)} ═══`);
  console.log(`  ticket Aloha ANTES: total=${t0.body.totals.total} paid=${t0.body.totals.paid} due=${t0.body.totals.due} tips=${t0.body.totals.tips} open=${t0.body.open}`);

  // 1. el "Flex" cobra: amount = total del cheque, tip aparte
  const pay=await clover.pay(CLOVER,{amount:1662,tip:TIP,externalPaymentId:`CERT-${TOK}-F41`});
  ev.clover_pay={status:pay.status,body:pay.body};
  console.log(`\n  Flex cobra: {amount:1662, tipAmount:${TIP}} -> HTTP ${pay.status}`);
  console.log(`    pago Clover ${pay.body?.id}: amount=${pay.body?.amount} tip=${pay.body?.tipAmount} result=${pay.body?.result}`);
  const co=await clover.order(CLOVER);
  console.log(`    orden Clover: total=${co.body?.total} paymentState=${co.body?.paymentState}  (cobrado a la tarjeta = ${1662+TIP})`);

  // 2. pull de pagos Clover -> MCM
  console.log('\n  … fetch_payments');
  const j=await db.syncNow(S,'clover','fetch_payments',120000);
  ev.fetch_payments={status:j.status,context:j.context,error:j.last_error};
  console.log(`  ${j.status}  ${JSON.stringify(j.context?.fetch_payments||{})}`);

  const pays=await db.payments(S,MCM); ev.mcm_payments=pays;
  pays.forEach(p=>console.log(`  MCM pago ${p.id}: total=${p.total} tip=${p.tip} pos_id=${p.pos_id} omni_pay=${p.additional_properties?.omnivore_payment_id||'—'}`));

  // 3. el forward a Omnivore
  console.log('\n  … payment_injection hacia Omnivore');
  let inj=null;
  for(let i=0;i<25;i++){ await sleep(3000);
    const js=await db.jobs(S,since);
    inj=js.find(x=>x.job_type==='payment_injection'&&x.integration==='omnivore');
    if(inj&&['completed','dead_letter'].includes(inj.status)) break; }
  ev.injection_job=inj;
  if(!inj){console.log('  ✗ no se encoló ningún payment_injection');}
  else{
    console.log(`  job ${inj.status}  key=${inj.idempotency_key}`);
    const body=inj.payload?.payment;
    console.log(`    CUERPO ENVIADO A OMNIVORE: amount=${body?.amount}  tip=${body?.tip}  tender=${body?.tender_type}`);
    if(inj.last_error) console.log(`    error: ${inj.last_error}`);
  }

  // 4. estado final del ticket en Aloha — la prueba
  await sleep(4000);
  const t1=await omni.ticket(TICKET); ev.omnivore_despues=t1.body?.totals;
  const T=t1.body.totals;
  console.log(`\n  ticket Aloha DESPUÉS: total=${T.total} paid=${T.paid} due=${T.due} tips=${T.tips} open=${t1.body.open}`);
  console.log(`\n  ══ VEREDICTO M1 ══`);
  console.log(`    cobrado en Clover : ${1662} + propina ${TIP}`);
  console.log(`    enviado a Omnivore: ${inj?.payload?.payment?.amount} + propina ${inj?.payload?.payment?.tip}`);
  console.log(`    due del cheque    : ${T.due}  (esperado 0 si el reenvío fuera correcto)`);
  if(T.due===TIP) console.log(`    ✗ CONFIRMADO: falta exactamente la propina (${TIP}). El cheque queda ABIERTO.`);
  else if(T.due===0) console.log(`    ✓ el cheque cerró: el reenvío fue correcto.`);
  else console.log(`    ? due=${T.due}, revisar.`);
  console.log('  evidencia ->',saveEvidence(`f4-1-${TOK}`,ev));
  await db.close();
})();
