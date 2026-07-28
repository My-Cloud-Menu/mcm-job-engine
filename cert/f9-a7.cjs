const L=require('./lib.cjs');
const {omni,clover,db,CERT_SITE:S,reconcile,saveEvidence,TOK,sleep}=L;
const els=x=>Array.isArray(x)?x:(x?.elements||[]);
(async()=>{
  const tid='20260726-1010013', mcmId=10048;
  console.log('═══ F9.A7 (bis) · descuento de ticket 20% sobre el cheque de F9 ═══');
  const t0=await omni.ticket(tid);
  console.log(`  antes: items=${t0.body.totals.items} disc=${t0.body.totals.discounts} tax=${t0.body.totals.tax} total=${t0.body.totals.total} open=${t0.body.open}`);
  const prev=t0.body.totals.total;

  // c39 "Owners 20%" — open=false, así que NO se manda `value`
  const d=await omni.call('POST',`/tickets/${tid}/discounts/`,[{discount:'c39'}]);
  console.log(`  aplicar c39 (Owners 20%) → HTTP ${d.status} ${d.ok?'ok':JSON.stringify(d.body?.errors)}`);
  if(!d.ok){ await db.close(); return; }

  const w=await omni.waitTotals(tid,prev);
  const T=w.totals;
  console.log(`  después: items=${T.items} disc=${T.discounts} sub_total=${T.sub_total} tax=${T.tax} svc=${T.service_charges} total=${T.total}`);
  console.log(`    (comprobación de la fórmula del POS: sub_total = items + other − disc = ${T.items} − ${T.discounts} = ${T.items-T.discounts} vs ${T.sub_total})`);

  const hashPrev=(await db.order(S,mcmId))?.clover_line_items_hash;
  await db.syncUntil(S,'omnivore','fetch_recent_orders',
    async()=>{const o=await db.order(S,mcmId);return L.cents(o.total)===Number(T.total)?o:null;},{maxCycles:4});
  const mcm=await db.order(S,mcmId);
  console.log(`\n  MCM: total=${mcm.total} subtotal=${mcm.subtotal} discount_total=${mcm.discount_total} tax=${mcm.total_tax}`);
  console.log(`    tax_lines: ${(mcm.tax_lines||[]).map(x=>`${x.rate_code}=${x.tax_total}(base ${x.subtotal})`).join(' | ')}`);
  console.log(`    coupon_lines: ${JSON.stringify(mcm.additional_properties?.coupon_lines??[])}  líneas=${(mcm.line_items||[]).length}`);

  await db.syncUntil(S,'clover','push_orders',
    async()=>{const o=await db.order(S,mcmId);return o?.clover_line_items_hash!==hashPrev?o:null;},{maxCycles:4});
  await sleep(6000);
  const m2=await db.order(S,mcmId);
  const cl=(await clover.order(m2.clover_ticket_id)).body;
  const rec=reconcile({omnivoreTotals:T,mcmOrder:m2,cloverOrder:cl});
  console.log(`\n  Clover total=${cl?.total}`);
  els(cl?.lineItems).forEach(li=>console.log(`    ${String(li.name).padEnd(34)} ${String(li.price).padStart(5)} + ${els(li.taxRates).reduce((a,x)=>a+(x.taxAmount||0),0)}`));
  console.log(`\n  ══ R5 ══`);
  console.log(`    POS=${rec.omnivore_total_cents}  MCM=${rec.mcm_total_cents}  Clover=${rec.clover_order_total}  Σlíneas=${rec.clover_sum_lines}`);
  console.log(`    Clover−MCM=${rec.clover_vs_mcm}  Σlíneas−total=${rec.clover_lines_vs_total}`);
  console.log(`    ${rec.cuadra?'✓ CUADRA — R5 NO REPRODUCIDO':'✗ NO CUADRA — R5 confirmado: el descuento no viaja a Clover'}`);
  console.log(`    pos_injection_error: ${m2.pos_injection_error?JSON.stringify(m2.pos_injection_error):'—'}`);
  saveEvidence(`f9-a7-${TOK}`,{ticket:tid,mcm:mcmId,omni:T,mcm_order:m2,clover:cl,rec});
  await db.close();
})();
