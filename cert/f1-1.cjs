const L=require('./lib.cjs');
const {omni,clover,db,CERT_SITE:S,TOK,sleep,cents,reconcile,saveEvidence}=L;
(async()=>{
  const since=new Date().toISOString();
  const name=`CERT-${TOK}-A1`; const TABLE='106';
  const ev={caso:'F1.1+F2.1 ciclo básico con 2 clases de tax', name, since};
  console.log(`\n═══ ${ev.caso} ═══\n  ticket name: ${name}  mesa: ${TABLE}`);

  // 1. mesero abre la mesa
  const t=await omni.openTicket({name,table:TABLE,guestCount:2});
  if(!t.ok){console.log('  ✗ open falló:',JSON.stringify(t.body));process.exit(1);}
  const tid=t.body.id; ev.omnivore_open={status:t.status,ticket_id:tid,ticket_number:t.body.ticket_number};
  console.log(`  ✓ ticket abierto: ${tid} (nº ${t.body.ticket_number})`);

  // 2. agrega 2 ítems: comida (reduced 6%) + alcohol (standard 10.5%)
  const add=await omni.addItems(tid,[
    {menu_item:'300015',quantity:1,auto_send:true},   // Chips & Salsa  $6.00  reduced
    {menu_item:'310010',quantity:1,auto_send:true},   // Monte Xanic    $9.00  standard
  ]);
  ev.omnivore_add={status:add.status,ok:add.ok,errors:add.body?.errors};
  console.log(`  ${add.ok?'✓':'✗'} ítems agregados (HTTP ${add.status})${add.body?.errors?' '+JSON.stringify(add.body.errors):''}`);

  // 3. totales autoritativos del POS
  const tk=await omni.ticket(tid);
  const tot=tk.body?.totals; ev.omnivore_totals=tot;
  console.log(`  POS totals: items=${tot?.items} tax=${tot?.tax} total=${tot?.total} due=${tot?.due} sub_total=${tot?.sub_total} svc=${tot?.service_charges}`);
  console.log(`    ítems en ticket: ${(tk.body?._embedded?.items||[]).map(i=>`${i.name}=${i.price}${i.sent?'(sent)':''}`).join(' | ')}`);

  // 4. esperar el sync Omnivore -> MCM
  console.log('\n  … esperando fetch_recent_orders');
  const job=await db.syncNow(S,'omnivore','fetch_recent_orders',180000);
  ev.sync_job={status:job.status,context:job.context,error:job.last_error};
  console.log(`  sync: ${job.status}  ${JSON.stringify(job.context?.fetch_recent_orders||{})}`);

  const mcm=await db.orderByOmnivore(S,tid);
  ev.mcm_order=mcm;
  if(!mcm){console.log('  ✗ la orden NO llegó a MCM');saveEvidence(`f1-1-${TOK}`,ev);await db.close();return;}
  console.log(`  ✓ MCM orden ${mcm.id}: status=${mcm.status} pay=${mcm.payment_status} total=${mcm.total} subtotal=${mcm.subtotal} tax=${mcm.total_tax}`);
  console.log(`    líneas: ${(mcm.line_items||[]).map(li=>`${li.name}=$${li.price}${li.product_id?'':' [SIN product_id]'}`).join(' | ')}`);
  console.log(`    tax_lines: ${(mcm.tax_lines||[]).map(t=>`${t.rate_code}=${t.tax_total} (base ${t.subtotal})`).join(' | ')}`);
  console.log(`    mesa: table_id=${mcm.table_id?'sí':'no'} check_number=${mcm.check_number} experience=${mcm.experience}`);

  // 5. esperar el push MCM -> Clover
  console.log('\n  … esperando push_orders');
  const pj=await db.syncNow(S,'clover','push_orders',120000);
  ev.push_job={status:pj.status,context:pj.context,error:pj.last_error};
  console.log(`  push: ${pj.status} ${JSON.stringify(pj.context?.push_orders||{})}`);
  let mcm2=null,cl=null;
  for(let i=0;i<20;i++){ await sleep(3000); mcm2=await db.order(S,mcm.id); if(mcm2?.clover_ticket_id) break; }
  ev.mcm_after_push=mcm2;
  if(!mcm2?.clover_ticket_id){ console.log('  ✗ no se creó la orden en Clover'); }
  else{
    console.log(`  ✓ Clover order: ${mcm2.clover_ticket_id}  hash=${mcm2.clover_line_items_hash}`);
    cl=(await clover.order(mcm2.clover_ticket_id)).body; ev.clover_order=cl;
    console.log(`    clover.total=${cl?.total} state=${cl?.state} paymentState=${cl?.paymentState}`);
    (cl?.lineItems?.elements||[]).forEach(li=>console.log(`      ${li.name}  price=${li.price}  tax=${(li.taxRates||[]).map(t=>`${t.name}:${t.taxAmount}`).join('+')||'—'}`));
  }
  // 6. cuadre triple
  const rec=reconcile({omnivoreTotals:tot,mcmOrder:mcm2||mcm,cloverOrder:cl}); ev.reconcile=rec;
  console.log(`\n  ══ CUADRE ══`);
  console.log(`    Omnivore=${rec.omnivore_total_cents}  MCM=${rec.mcm_total_cents}  Clover.total=${rec.clover_order_total}  Σlíneas=${rec.clover_sum_lines}`);
  console.log(`    MCM−Omnivore=${rec.mcm_vs_omnivore}  Clover−MCM=${rec.clover_vs_mcm}  Σlíneas−total=${rec.clover_lines_vs_total}`);
  console.log(`    ${rec.cuadra?'✓ CUADRA AL CENTAVO':'✗ NO CUADRA'}`);
  const n=await L.assertNeighborsIntact('F1.1'); ev.neighbors=n;
  console.log(`    vecinos intactos: ${n.ok?'sí':'NO'}`);
  console.log('  evidencia ->',saveEvidence(`f1-1-${TOK}`,ev));
  await db.close();
})();
