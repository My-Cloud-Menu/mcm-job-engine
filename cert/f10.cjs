/**
 * F10 · Edición durante el cobro (orden suplementaria).
 *
 * Escenario real: la mesa divide la cuenta. El primer comensal paga con el Flex
 * (pago PARCIAL, así el cheque de Aloha sigue ABIERTO — Aloha solo deja mutar
 * tickets abiertos). Después se pide algo más. Como Clover NO permite mutar una
 * orden que ya tiene pagos, lo agregado debe facturarse en una SEGUNDA orden
 * Clover (suplemento) y su pago debe re-atribuirse a la MISMA orden MCM.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, sleep, saveEvidence, TOK } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

(async () => {
  const tb = await omni.call('GET','/tables/?limit=1000');
  const libres = els(tb.body?._embedded?.tables).filter((x)=>x.available).map((x)=>String(x.id));
  const TABLE = process.env.F10_TABLE || libres[80], name = `CERT-${TOK}-F10`;
  const ev = { caso: 'F10 · edición durante el cobro', pasos: [] };
  const since = new Date().toISOString();
  console.log(`═══ F10 · edición durante el cobro · mesa ${TABLE} ═══`);

  // ── B1: mesa con 2 ítems, sincronizada y empujada
  const t = await omni.openTicket({ name, table: TABLE, guestCount: 2 });
  if (!t.ok) { console.log('✗ open:', JSON.stringify(t.body?.errors)); process.exit(1); }
  const tid = t.body.id;
  await omni.addItems(tid, [
    { menu_item: '300015', quantity: 1, auto_send: true },   // Chips & Salsa $6
    { menu_item: '300025', quantity: 1, auto_send: true },   // Elote $13
  ]);
  const tot1 = (await omni.ticket(tid)).body.totals;
  console.log(`B1 · ticket ${tid}  total POS = ${tot1.total}`);

  const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
  if (!r1.got) { console.log('✗ no llegó a MCM'); process.exit(1); }
  const mcmId = r1.got.id;
  const r2 = await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
  const cloverId = r2.got?.clover_ticket_id;
  console.log(`     MCM ${mcmId} → Clover ${cloverId}`);
  ev.pasos.push({ paso: 'B1', ticket: tid, mcm: mcmId, clover: cloverId, total: tot1.total });

  // ── B2: el primer comensal paga PARCIAL con el Flex
  const parcial = Math.floor(Number(tot1.total) / 2);
  const pay1 = await clover.pay(cloverId, { amount: parcial, tip: 0, externalPaymentId: `CERT-${TOK}-F10-P1` });
  const co1 = await clover.order(cloverId);
  console.log(`\nB2 · pago parcial ${parcial} de ${tot1.total} → HTTP ${pay1.status}  paymentState=${co1.body?.paymentState}`);
  await db.syncUntil(S, 'clover', 'fetch_payments',
    async () => { const ps = await db.payments(S, mcmId); return ps.find((p) => p.pos_id === pay1.body?.id) || null; }, { maxCycles: 3 });
  const mcmA = await db.order(S, mcmId);
  console.log(`     MCM: paid=${mcmA.paid} payment_status=${mcmA.payment_status} status=${mcmA.status}`);
  ev.pasos.push({ paso: 'B2', pago: pay1.body?.id, parcial, paymentState: co1.body?.paymentState, mcm_paid: mcmA.paid, mcm_pay_status: mcmA.payment_status });

  // ── B3: se agrega un ítem en el terminal (el cheque sigue abierto)
  const tkOpen = (await omni.ticket(tid)).body;
  console.log(`\nB3 · cheque Aloha open=${tkOpen.open} due=${tkOpen.totals.due} → agrego 1 ítem`);
  const add = await omni.addItems(tid, [{ menu_item: '300155', quantity: 1, price_level: 'b0', auto_send: true }]); // Arroz Verde $5
  console.log(`     add → HTTP ${add.status} ${add.ok ? 'ok' : JSON.stringify(add.body?.errors)}`);
  // Aloha tarda ~1.5 s en reflejar la mutación en totals — esperar o se lee el estado viejo
  const tot2 = (await omni.waitTotals(tid, tot1.total)).totals;
  console.log(`     total POS ahora = ${tot2.total} (antes ${tot1.total})`);

  // ── B4-B8: sync + push → debe salir por el camino suplementario
  await db.syncUntil(S, 'omnivore', 'fetch_recent_orders',
    async () => { const o = await db.order(S, mcmId); return L.cents(o.total) === Number(tot2.total) ? o : null; }, { maxCycles: 4 });
  const mcmB = await db.order(S, mcmId);
  console.log(`     MCM total=${mcmB.total} líneas=${(mcmB.line_items || []).length}`);

  await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.additional_properties?.clover_supplemental ? o : null; }, { maxCycles: 4 });
  await sleep(6000);
  const mcmC = await db.order(S, mcmId);
  const manifest = mcmC.additional_properties?.clover_supplemental;
  console.log(`\nB4-B8 · manifiesto suplementario: ${manifest ? 'SÍ' : 'NO'}`);
  if (manifest) console.log('     ' + JSON.stringify(manifest));
  ev.pasos.push({ paso: 'B4-B8', mcm_total: mcmC.total, manifest, pos_injection_error: mcmC.pos_injection_error });

  const jobs = await db.jobs(S, since);
  const supJob = jobs.find((j) => j.job_type === 'supplemental_order_injection');
  console.log(`     job supplemental_order_injection: ${supJob ? supJob.status : 'NO EXISTE'}`);
  if (supJob?.last_error) console.log(`     error: ${supJob.last_error.slice(0, 120)}`);
  ev.pasos.push({ paso: 'job_suplemento', status: supJob?.status, error: supJob?.last_error, idem: supJob?.idempotency_key });

  // ── estado de las órdenes Clover
  const supId = manifest?.supplements?.[0]?.clover_order_id;
  const co2 = await clover.order(cloverId);
  console.log(`\n     orden Clover PRIMARIA ${cloverId}: total=${co2.body?.total} paymentState=${co2.body?.paymentState}`);
  els(co2.body?.lineItems).forEach((li) => console.log(`       ${li.name} = ${li.price}`));
  let cs = null;
  if (supId) {
    cs = await clover.order(supId);
    console.log(`     orden Clover SUPLEMENTO ${supId}: total=${cs.body?.total} paymentState=${cs.body?.paymentState}`);
    els(cs.body?.lineItems).forEach((li) => console.log(`       ${li.name} = ${li.price}`));
  }
  ev.clover_primaria = co2.body; ev.clover_suplemento = cs?.body;

  // ── B9-B10: cobrar el suplemento y ver a qué orden MCM se atribuye
  if (supId && cs?.body?.total > 0) {
    const pay2 = await clover.pay(supId, { amount: cs.body.total, tip: 0, externalPaymentId: `CERT-${TOK}-F10-P2` });
    console.log(`\nB9 · pago del suplemento ${cs.body.total} → HTTP ${pay2.status}`);
    await db.syncUntil(S, 'clover', 'fetch_payments',
      async () => { const ps = await db.payments(S, mcmId); return ps.find((p) => p.pos_id === pay2.body?.id) || null; }, { maxCycles: 4 });
    const pays = await db.payments(S, mcmId);
    const mcmD = await db.order(S, mcmId);
    console.log(`B10 · pagos atribuidos a la orden MCM ${mcmId}:`);
    pays.forEach((p) => console.log(`       pago ${p.id}: total=${p.total} pos_id=${p.pos_id} omni=${p.additional_properties?.omnivore_payment_id || '—'}`));
    const suma = pays.filter((p) => p.status === 'completed').reduce((a, p) => a + Number(p.total), 0);
    console.log(`     Σ pagos = ${suma.toFixed(2)}   MCM.total = ${mcmD.total}   MCM.paid = ${mcmD.paid}`);
    console.log(`     ${Math.abs(suma - Number(mcmD.total)) < 0.02 ? '✓ los dos pagos cubren el total sin doble conteo' : '✗ descuadre'}`);
    ev.pasos.push({ paso: 'B9-B10', pagos: pays.map((p) => ({ id: p.id, total: p.total, pos_id: p.pos_id })), suma, mcm_total: mcmD.total, mcm_paid: mcmD.paid });
  }

  const tf = await omni.ticket(tid);
  console.log(`\n     cheque Aloha final: due=${tf.body?.totals?.due} paid=${tf.body?.totals?.paid} open=${tf.body?.open}`);
  ev.omnivore_final = tf.body?.totals;
  const n = await L.assertNeighborsIntact('F10'); ev.neighbors = n;
  console.log(`     vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  console.log('\nevidencia →', saveEvidence(`f10-${TOK}`, ev));
  await db.close();
})();
