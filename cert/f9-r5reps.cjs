const L=require('./lib.cjs');
const {omni,clover,db,CERT_SITE:S,reconcile,saveEvidence,TOK,sleep}=L;
const els=x=>Array.isArray(x)?x:(x?.elements||[]);
async function caso({tag,items,discount,table}){
  const t=await omni.openTicket({name:`CERT-${TOK}-${tag}`,table,guestCount:2});
  if(!t.ok) return {tag,error:'open:'+JSON.stringify(t.body?.errors)};
  const tid=t.body.id;
  await omni.addItems(tid,items.map(m=>({menu_item:m,quantity:1,auto_send:true})));
  let w=await omni.waitTotals(tid,0);
  const sinDesc=w.totals.total;
  const r1=await db.syncUntil(S,'omnivore','fetch_recent_orders',()=>db.orderByOmnivore(S,tid),{maxCycles:4});
  if(!r1.got) return {tag,ticket:tid,error:'no llegó a MCM'};
  const mcmId=r1.got.id;
  await db.syncUntil(S,'clover','push_orders',async()=>{const o=await db.order(S,mcmId);return o?.clover_ticket_id?o:null;},{maxCycles:3});
  // aplicar el descuento
  const d=await omni.call('POST',`/tickets/${tid}/discounts/`,[{discount}]);
  if(!d.ok) return {tag,ticket:tid,mcm:mcmId,error:'discount:'+JSON.stringify(d.body?.errors)};
  w=await omni.waitTotals(tid,sinDesc);
  const T=w.totals;
  const hashPrev=(await db.order(S,mcmId))?.clover_line_items_hash;
  await db.syncUntil(S,'omnivore','fetch_recent_orders',
    async()=>{const o=await db.order(S,mcmId);return L.cents(o.total)===Number(T.total)?o:null;},{maxCycles:4});
  await db.syncUntil(S,'clover','push_orders',
    async()=>{const o=await db.order(S,mcmId);return o?.clover_line_items_hash!==hashPrev?o:null;},{maxCycles:4});
  await sleep(6000);
  const m2=await db.order(S,mcmId);
  const cl=(await clover.order(m2.clover_ticket_id)).body;
  const rec=reconcile({omnivoreTotals:T,mcmOrder:m2,cloverOrder:cl});
  return {tag,ticket:tid,mcm:mcmId,discount,
    sin_descuento:sinDesc, pos_total:T.total, pos_disc:T.discounts,
    mcm_total:m2.total, clover_total:cl?.total, delta:rec.clover_vs_mcm,
    pos_injection_error:m2.pos_injection_error, cuadra:rec.cuadra};
}
(async()=>{
  // mesas reales disponibles, tomadas del POS (los ids NO son un rango contiguo)
  const tb=await omni.call('GET','/tables/?limit=1000');
  const libres=(tb.body?._embedded?.tables||[]).filter(t=>t.available).map(t=>String(t.id));
  console.log(`mesas disponibles: ${libres.length} — usando ${libres.slice(40,42).join(', ')}`);
  const out=[];
  for(const c of [
    {tag:'R5b',items:['300015','300025'],discount:'c39',table:libres[40]},   // 20%
    {tag:'R5c',items:['300110','310010'],discount:'c83',table:libres[41]},   // 100% comp
  ]){
    const r=await caso(c); out.push(r);
    console.log(`\n── ${r.tag} (${r.discount})`);
    if(r.error){console.log(`   ✗ ${r.error}`);continue;}
    console.log(`   sin descuento=${r.sin_descuento}  POS con descuento=${r.pos_total} (disc=${r.pos_disc})`);
    console.log(`   MCM=${L.cents(r.mcm_total)}  Clover=${r.clover_total}  Δ=${r.delta}`);
    console.log(`   pos_injection_error=${r.pos_injection_error?JSON.stringify(r.pos_injection_error):'null (sin señal de error)'}`);
    console.log(`   ${r.cuadra?'✓ cuadra':'✗ NO CUADRA — Clover cobra de más'}`);
  }
  saveEvidence(`f9-r5reps-${TOK}`,out);
  const n=await L.assertNeighborsIntact('R5reps'); console.log(`\n  vecinos intactos: ${n.ok?'sí':'NO'}`);
  await db.close();
})();
