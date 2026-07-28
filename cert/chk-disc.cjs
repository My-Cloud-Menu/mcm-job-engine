const L=require('./lib.cjs');
(async()=>{
  const r=await L.omni.call('GET','/discounts/?limit=100');
  const d=r.body._embedded.discounts||[];
  console.log(`total descuentos: ${d.length}`);
  const usables=d.filter(x=>x.available);
  console.log(`con available=true: ${usables.length}\n`);
  console.log('  id     open  type     applies_to           value      name');
  usables.forEach(x=>console.log(
    `  ${String(x.id).padEnd(6)} ${String(x.open).padEnd(5)} ${String(x.type).padEnd(8)} ${JSON.stringify(x.applies_to).padEnd(20)} ${String(x.value??'—').padEnd(10)} ${x.name}`));
  const ticketOk=usables.filter(x=>x.applies_to?.ticket);
  console.log(`\n  aplicables a TICKET: ${ticketOk.length} -> ${ticketOk.map(x=>`${x.id}(${x.name}, ${x.type}, open=${x.open})`).join(' | ')||'NINGUNO'}`);
  const itemOk=usables.filter(x=>x.applies_to?.item);
  console.log(`  aplicables a ÍTEM:   ${itemOk.length} -> ${itemOk.slice(0,5).map(x=>`${x.id}(${x.name}, ${x.type}, open=${x.open})`).join(' | ')}`);
  L.saveEvidence(`discounts-${L.TOK}`,{total:d.length,usables});
  await L.db.close();
})();
