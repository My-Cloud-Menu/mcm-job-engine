const L=require('./lib.cjs');
(async()=>{
  const OID='CRV219DTMBHX8';
  for(const q of ['?expand=taxRates','?expand=taxRates,modifications,discounts','']){
    const r=await L.clover.call('GET',`/orders/${OID}/line_items${q}`);
    console.log(`\n── GET /orders/${OID}/line_items${q}  -> HTTP ${r.status}`);
    (r.body?.elements||[]).forEach(li=>{
      const tr=(li.taxRates||[]).map(t=>`${t.name}=${t.taxAmount}(rate ${t.rate})`).join(' + ')||'SIN taxRates';
      console.log(`   ${String(li.name).padEnd(32)} price=${String(li.price).padStart(5)}  ${tr}`);
    });
    if(q) break;
  }
  // y la orden completa con el expand correcto
  const o=await L.clover.call('GET',`/orders/${OID}?expand=lineItems.taxRates,payments`);
  console.log(`\n── GET /orders/${OID}?expand=lineItems.taxRates -> HTTP ${o.status}`);
  console.log(`   order.total=${o.body?.total}  paymentState=${o.body?.paymentState}`);
  const els=o.body?.lineItems?.elements||[];
  let sum=0;
  els.forEach(li=>{ const t=(li.taxRates||[]).reduce((a,x)=>a+(x.taxAmount||0),0); sum+=(li.price||0)+t;
    console.log(`   ${String(li.name).padEnd(32)} price=${String(li.price).padStart(5)} tax=${t}`); });
  console.log(`   Σ(price+tax) = ${sum}   vs order.total = ${o.body?.total}   Δ=${sum-(o.body?.total||0)}`);
  await L.db.close();
})();
