const L=require('./lib.cjs');
(async()=>{
  const tid='20260726-1010008';
  const t=await L.omni.ticket(tid);
  console.log('ticket',tid,'open=',t.body.open);
  console.log('totals:',JSON.stringify(t.body.totals));
  console.log('ítems en el ticket:');
  (t.body._embedded?.items||[]).forEach(i=>console.log(`   id=${i.id} ${i.name} price=${i.price} qty=${i.quantity} sent=${i.sent}`));
  // reintento explícito del add que "no apareció"
  const r=await L.omni.addItems(tid,[{menu_item:'300155',quantity:1,auto_send:true}]);
  console.log('\nreintento add 300155 -> HTTP',r.status,'ok=',r.ok);
  if(r.body?.errors) console.log('  errors:',JSON.stringify(r.body.errors));
  const t2=await L.omni.ticket(tid);
  console.log('totals después:',JSON.stringify(t2.body.totals));
  await L.db.close();
})();
