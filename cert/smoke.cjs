const L=require('./lib.cjs');
(async()=>{
  console.log(`TOK de corrida: ${L.TOK}   site cert: ${L.CERT_SITE}\n`);

  // 1. el guard multi-tenant debe TIRAR si falta site_id
  let guarded=false;
  try { await L.db.order(undefined, 1); } catch(e){ guarded=/multi-tenant/.test(e.message); console.log('  guard site_id faltante  ->', e.message); }
  try { await L.db.q(L.CERT_SITE, 'select 1'); } catch(e){ console.log('  guard SQL sin $1        ->', e.message); }
  console.log(`  [${guarded?'OK':'FALLA'}] el helper exige site_id\n`);

  // 2. schedules del site cert
  const sch=await L.db.schedules(L.CERT_SITE);
  console.log('  schedules activos:', sch.filter(s=>s.status==='active').map(s=>`${s.integration}.${s.sync_type}@${s.interval_seconds}s`).join(', '));

  // 3. Omnivore vivo
  const t=await L.omni.openTickets();
  console.log(`  Omnivore: HTTP ${t.status}, tickets abiertos = ${t.body?._embedded?.tickets?.length ?? '?'}`);

  // 4. Clover vivo
  const c=await L.clover.call('GET','/tenders');
  console.log(`  Clover:   HTTP ${c.status}, tenders = ${c.body?.elements?.length ?? '?'}`);

  // 5. vecinos
  const n=await L.assertNeighborsIntact('smoke');
  console.log(`  vecinos intactos: ${n.ok?'SÍ':'NO — '+JSON.stringify(n.violaciones)}`);

  // 6. productos del site (scoped)
  const p=await L.db.q(L.CERT_SITE, `select count(*)::int n from products where site_id=$1`);
  console.log(`  productos del site cert: ${p[0].n}`);
  await L.db.close();
})();
