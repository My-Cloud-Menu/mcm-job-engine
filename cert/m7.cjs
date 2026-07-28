/**
 * M7 · Un cheque cobrado en EFECTIVO en el terminal Aloha ¿se empuja igual a Clover?
 *
 * Predicción: `getOrdersPendingSyncToClover` (clover-helper.ts:1405-1410) incluye
 * `check-closed` entre los estados elegibles y **no filtra por `payment_status`**,
 * así que un cheque ya cobrado en efectivo se empuja a Clover como orden ABIERTA
 * que nadie va a pagar nunca. En un restaurante con 20-40 % de efectivo, el
 * Register acumula órdenes fantasma cada servicio.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

(async () => {
  const ev = { caso: 'M7 · cheque pagado en efectivo en Aloha' };
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  const TABLE = libres[100];
  console.log(`═══ M7 · cobro en EFECTIVO en el POS · mesa ${TABLE} ═══`);

  const t = await omni.openTicket({ name: `CERT-${TOK}-M7`, table: TABLE, guestCount: 1 });
  if (!t.ok) { console.log('✗ open:', JSON.stringify(t.body?.errors)); process.exit(1); }
  const tid = t.body.id;
  await omni.addItems(tid, [{ menu_item: '300015', quantity: 1, auto_send: true }]); // Chips $6
  const w = await omni.waitTotals(tid, 0);
  console.log(`  ticket ${tid}  total=${w.totals.total}`);

  // ── el mesero cobra en EFECTIVO en el terminal (Payment<cash> no lleva tender_type)
  const pagoCash = await omni.call('POST', `/tickets/${tid}/payments/`,
    { type: 'cash', amount: w.totals.total, tip: 0, auto_close: true });
  console.log(`  cobro en efectivo → HTTP ${pagoCash.status} ${pagoCash.ok ? 'ok' : JSON.stringify(pagoCash.body?.errors)}`);
  ev.pago_cash = { status: pagoCash.status, body: pagoCash.body };
  if (!pagoCash.ok) { console.log('  ✗ no se pudo cobrar en efectivo'); saveEvidence(`m7-${TOK}`, ev); await db.close(); return; }

  const tk = await omni.ticket(tid);
  console.log(`  cheque Aloha: due=${tk.body?.totals?.due} paid=${tk.body?.totals?.paid} open=${tk.body?.open}`);
  ev.aloha = tk.body?.totals;

  // ── sync a MCM
  const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
  if (!r1.got) { console.log('  ✗ no llegó a MCM'); saveEvidence(`m7-${TOK}`, ev); await db.close(); return; }
  const mcmId = r1.got.id;
  await sleep(3000);
  const mcm = await db.order(S, mcmId);
  console.log(`\n  MCM orden ${mcmId}: status=${mcm.status} payment_status=${mcm.payment_status} paid=${mcm.paid} total=${mcm.total}`);
  const pays = await db.payments(S, mcmId);
  pays.forEach((p) => console.log(`    pago MCM ${p.id}: ${p.method} ${p.total} source=${p.source} ref=${p.reference}`));
  ev.mcm = { orden: mcm, pagos: pays };

  // ── ¿se empuja a Clover pese a estar ya cobrado?
  console.log(`\n  … push_orders`);
  const r2 = await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
  await sleep(6000);
  const m2 = await db.order(S, mcmId);
  ev.mcm_tras_push = m2;
  console.log(`  clover_ticket_id: ${m2.clover_ticket_id || 'null (no se empujó)'}`);

  if (m2.clover_ticket_id) {
    const cl = await clover.order(m2.clover_ticket_id);
    console.log(`  orden Clover ${m2.clover_ticket_id}: total=${cl.body?.total} state=${cl.body?.state} paymentState=${cl.body?.paymentState}`);
    els(cl.body?.lineItems).forEach((li) => console.log(`    ${li.name} = ${li.price}`));
    ev.clover = cl.body;
    console.log(`\n  ══ VEREDICTO M7 ══`);
    if (cl.body?.paymentState === 'OPEN') {
      console.log(`    ✗ CONFIRMADO: el cheque se cobró en efectivo en Aloha (due=0, cerrado)`);
      console.log(`      pero igual se creó una orden ABIERTA en Clover por ${cl.body.total} centavos.`);
      console.log(`      Nadie la va a pagar nunca → queda como orden fantasma en el Register.`);
    } else {
      console.log(`    ~ la orden Clover quedó en paymentState=${cl.body?.paymentState}, revisar`);
    }
  } else {
    console.log(`\n  ══ VEREDICTO M7 ══`);
    console.log(`    ✓ NO REPRODUCIDO: el cheque cobrado en efectivo NO se empujó a Clover`);
  }
  saveEvidence(`m7-${TOK}`, ev);
  const n = await L.assertNeighborsIntact('M7');
  console.log(`    vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
