const L=require('./lib.cjs');
const {omni,sleep}=L;
(async()=>{
  console.log('Midiendo el lag de Aloha entre aceptar un add y reflejarlo en totals\n');
  const res=[];
  for(let n=1;n<=3;n++){
    const t=await omni.openTicket({name:`CERT-${L.TOK}-LAG${n}`,table:String(204+n),guestCount:1});
    if(!t.ok){console.log(`  ✗ open: ${JSON.stringify(t.body?.errors)}`);continue;}
    const tid=t.body.id;
    const antes=(await omni.ticket(tid)).body.totals.items;
    const t0=Date.now();
    const add=await omni.addItems(tid,[{menu_item:'300025',quantity:1,auto_send:true}]); // Elote $13
    const tPost=Date.now()-t0;
    let lag=null,val=antes;
    for(let i=0;i<40;i++){
      const tt=await omni.ticket(tid);
      val=tt.body.totals.items;
      if(val!==antes){lag=Date.now()-t0;break;}
      await sleep(250);
    }
    res.push({n,ticket:tid,http_ms:tPost,lag_ms:lag,items_antes:antes,items_despues:val});
    console.log(`  #${n} ticket ${tid}: POST respondió en ${tPost}ms, totals reflejó el cambio a los ${lag===null?'>10000':lag}ms  (items ${antes} -> ${val})`);
  }
  const lags=res.map(r=>r.lag_ms).filter(x=>x!=null);
  if(lags.length) console.log(`\n  lag: min=${Math.min(...lags)}ms  max=${Math.max(...lags)}ms  promedio=${Math.round(lags.reduce((a,b)=>a+b,0)/lags.length)}ms`);
  L.saveEvidence(`lag-aloha-${L.TOK}`,res);
  await L.db.close();
})();
