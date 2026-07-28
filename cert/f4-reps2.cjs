const L=require('./lib.cjs'); const {ciclo}=require('./ciclo.cjs');
(async()=>{
  const casos=[
    {tag:'R2',items:['300155','300110'],tip:250,table:'110'},
    {tag:'C0',items:['300015'],tip:0,table:'111'},
    {tag:'C1',items:['300025'],tip:0,table:'112'},
  ];
  const out=[];
  for(const c of casos){ const r=await ciclo(c); out.push(r);
    console.log(`\n── ${r.tag}${r.fase?`  ✗ falló en ${r.fase}: ${r.error}`:''}`);
    if(r.fase) continue;
    console.log(`   ticket=${r.ticket} cheque=${r.cheque_total} propina=${r.tip_cobrado}`);
    console.log(`   MCM pago: total=${r.mcm_pay_total} tip=${r.mcm_pay_tip}`);
    console.log(`   enviado a Omnivore: amount=${r.enviado_amount} tip=${r.enviado_tip}  job=${r.job}`);
    if(r.error) console.log(`   error: ${r.error}`);
    console.log(`   cheque final: due=${r.due_final} paid=${r.paid_final} tips=${r.tips_final} open=${r.open_final}  omni_pay=${r.omni_pay_id||'—'}`);
  }
  L.saveEvidence(`f4-reps2-${L.TOK}`,out);
  console.log('\n══ TABLA ══');
  console.log('  tag  cheque  propina  enviado  job          due_final  cerró');
  out.filter(r=>!r.fase).forEach(r=>console.log(
    `  ${r.tag.padEnd(4)} ${String(r.cheque_total).padStart(6)} ${String(r.tip_cobrado).padStart(8)} ${String(r.enviado_amount).padStart(8)}  ${String(r.job).padEnd(12)} ${String(r.due_final).padStart(9)}  ${r.open_final===false?'sí':'NO'}`));
  await L.db.close();
})();
