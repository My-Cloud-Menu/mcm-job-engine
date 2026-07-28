const L=require('./lib.cjs');
const {omni}=L;
(async()=>{
  const t=await omni.openTicket({name:`CERT-${L.TOK}-PL`,table:'208',guestCount:1});
  const tid=t.body.id; console.log('ticket',tid,'\n');
  // sin price_level
  let prev=(await omni.ticket(tid)).body.totals.total;
  await omni.addItems(tid,[{menu_item:'300155',quantity:1,auto_send:true}]);
  let w=await omni.waitTotals(tid,prev); prev=w.totals.total;
  console.log(`  A) 300155 SIN price_level  -> items=${w.totals.items}  (esperado 500 si tomara su nivel)`);
  (w.ticket._embedded.items||[]).forEach(i=>console.log(`       ${i.name} price=${i.price}`));
  // con price_level b0
  await omni.addItems(tid,[{menu_item:'300155',quantity:1,price_level:'b0',auto_send:true}]);
  w=await omni.waitTotals(tid,prev); prev=w.totals.total;
  console.log(`\n  B) 300155 CON price_level='b0' -> items=${w.totals.items}`);
  (w.ticket._embedded.items||[]).forEach(i=>console.log(`       ${i.name} price=${i.price}`));
  await L.saveEvidence(`price-level-${L.TOK}`,{ticket:tid,final:w.totals});
  await L.db.close();
})();
