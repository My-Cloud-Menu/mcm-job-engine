const L=require('./lib.cjs');
(async()=>{
  const o=await L.db.order(L.CERT_SITE,10036);
  console.log('orden 10036 (F1.1):');
  console.log('  additional_properties:',JSON.stringify(o.additional_properties));
  console.log('  channel=',o.channel,' experience=',o.experience,' table_id=',o.table_id?'sí':'no');
  console.log('  omnivore_managed =',o.additional_properties?.omnivore_managed ?? '(ausente)');
  const cfg=await L.db.q(L.CERT_SITE,`select config->>'omnivoreTableServiceEnabled' t from site_integrations where site_id=$1 and provider='omnivore'`);
  console.log('  omnivoreTableServiceEnabled del site =',cfg[0].t);
  // mesas realmente disponibles
  const r=await L.omni.call('GET','/tables/?limit=1000');
  const libres=(r.body._embedded.tables||[]).filter(t=>t.available).map(t=>t.id);
  console.log(`\nmesas disponibles: ${libres.length}  -> usaré: ${libres.slice(20,30).join(', ')}`);
  await L.db.close();
})();
