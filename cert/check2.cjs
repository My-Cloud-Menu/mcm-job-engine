const L=require('./lib.cjs');
const els=x=>Array.isArray(x)?x:(x?.elements||[]);
(async()=>{
  const OID='CRV219DTMBHX8';
  const o=await L.clover.order(OID);
  console.log(`GET orden con expand correcto -> HTTP ${o.status}`);
  console.log(`  order.total=${o.body?.total}  state=${o.body?.state}  paymentState=${o.body?.paymentState}\n`);
  let sum=0;
  els(o.body?.lineItems).forEach(li=>{
    const tr=els(li.taxRates);
    const t=tr.reduce((a,x)=>a+(x.taxAmount||0),0); sum+=(li.price||0)+t;
    console.log(`  ${String(li.name).padEnd(34)} price=${String(li.price).padStart(5)}  tax=${String(t).padStart(4)}  [${tr.map(x=>`${x.name}:${x.taxAmount}@${x.rate}`).join(', ')}]`);
  });
  console.log(`\n  Σ(price+tax) = ${sum}    order.total = ${o.body?.total}    Δ = ${sum-(o.body?.total||0)}`);
  const rec=L.reconcile({omnivoreTotals:{total:1662},mcmOrder:{total:'16.62'},cloverOrder:o.body});
  console.log(`\n  reconcile(): ${rec.cuadra?'✓ CUADRA':'✗ no cuadra'}  ${JSON.stringify(rec)}`);
  await L.db.close();
})();
