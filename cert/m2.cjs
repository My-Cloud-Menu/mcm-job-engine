/**
 * M2 · Void y refund de un pago de Clover: ¿se propagan?
 *
 * Predicción del análisis: `upsert-payments.ts:140-181` actualiza
 * `clover_payment_map.{voided,total_refunded}` y `payments.total_refunded`, pero
 * NO cambia `payments.status`, NO recalcula `orders.paid/payment_status`, y NO
 * existe camino de reversa hacia Omnivore.
 *
 * Primero hay que descubrir cuál endpoint de refund/void acepta el sandbox: el
 * dump local no los documenta y una corrida previa del harness reportó 405.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

async function probeRefund(paymentId, orderId, amount) {
  const intentos = [
    { label: 'POST /payments/{id}/refunds', m: 'POST', p: `/payments/${paymentId}/refunds`, b: { amount } },
    { label: 'POST /refunds (payment)', m: 'POST', p: '/refunds', b: { payment: { id: paymentId }, amount } },
    { label: 'POST /orders/{id}/refunds', m: 'POST', p: `/orders/${orderId}/refunds`, b: { amount } },
  ];
  const res = [];
  for (const it of intentos) {
    const r = await clover.call(it.m, it.p, it.b);
    res.push({ ...it, status: r.status, body: r.body });
    console.log(`     ${it.label} → HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    if (r.status >= 200 && r.status < 300) return { ok: true, usado: it.label, refund: r.body, intentos: res };
  }
  return { ok: false, intentos: res };
}

(async () => {
  const ev = { caso: 'M2 · void/refund de pago Clover' };
  // mesa real
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const libres = els(tb.body?._embedded?.tables).filter((t) => t.available).map((t) => String(t.id));
  const TABLE = libres[50];
  console.log(`═══ M2 · void/refund · mesa ${TABLE} ═══`);

  const t = await omni.openTicket({ name: `CERT-${TOK}-M2`, table: TABLE, guestCount: 1 });
  if (!t.ok) { console.log('✗ open:', JSON.stringify(t.body?.errors)); process.exit(1); }
  const tid = t.body.id;
  await omni.addItems(tid, [{ menu_item: '300025', quantity: 1, auto_send: true }]); // Elote $13
  const w = await omni.waitTotals(tid, 0);
  const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
  if (!r1.got) { console.log('✗ no llegó a MCM'); process.exit(1); }
  const mcmId = r1.got.id;
  const r2 = await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
  const cloverId = r2.got.clover_ticket_id;
  console.log(`  ticket ${tid} → MCM ${mcmId} → Clover ${cloverId}  total=${w.totals.total}`);

  // cobro SIN propina para que el forward a Omnivore funcione y el cheque cierre
  const pay = await clover.pay(cloverId, { amount: w.totals.total, tip: 0, externalPaymentId: `CERT-${TOK}-M2` });
  console.log(`  pago Clover ${pay.body?.id} → HTTP ${pay.status}`);
  await db.syncUntil(S, 'clover', 'fetch_payments',
    async () => { const ps = await db.payments(S, mcmId); return ps.find((p) => p.pos_id === pay.body?.id) || null; }, { maxCycles: 4 });
  await sleep(8000);

  const antesPays = await db.payments(S, mcmId);
  const antesOrder = await db.order(S, mcmId);
  const antesTicket = await omni.ticket(tid);
  console.log(`\n  ANTES del refund:`);
  antesPays.forEach((p) => console.log(`    pago MCM ${p.id}: status=${p.status} total=${p.total} refunded=${p.total_refunded} omni=${p.additional_properties?.omnivore_payment_id || '—'}`));
  console.log(`    orden MCM: paid=${antesOrder.paid} payment_status=${antesOrder.payment_status} status=${antesOrder.status}`);
  console.log(`    cheque Aloha: due=${antesTicket.body?.totals?.due} paid=${antesTicket.body?.totals?.paid} open=${antesTicket.body?.open}`);
  ev.antes = { pagos: antesPays, orden: antesOrder, aloha: antesTicket.body?.totals };

  // ── descubrir el endpoint de refund
  console.log(`\n  buscando el endpoint de refund que acepta el sandbox:`);
  const rf = await probeRefund(pay.body.id, cloverId, w.totals.total);
  ev.refund_probe = rf;
  if (!rf.ok) { console.log(`  ⚠ ningún endpoint de refund aceptó — M2 queda NO VERIFICADO por el lado del refund`); }
  else console.log(`  ✓ refund aceptado vía ${rf.usado}`);

  // ── pull y estado después
  await db.syncUntil(S, 'clover', 'fetch_payments', async () => true, { maxCycles: 2 });
  await sleep(8000);
  const cp = await clover.payment(pay.body.id);
  const despuesPays = await db.payments(S, mcmId);
  const despuesOrder = await db.order(S, mcmId);
  const despuesTicket = await omni.ticket(tid);
  const map = await db.q(S, `select clover_payment_id, mcm_payment_id, voided, total_refunded from clover_payment_map where site_id=$1 and clover_payment_id=$2`, [pay.body.id]);
  console.log(`\n  DESPUÉS:`);
  console.log(`    pago en Clover: result=${cp.body?.result} refunds=${els(cp.body?.refunds).length} (${els(cp.body?.refunds).map((r) => r.amount).join(',')})`);
  console.log(`    clover_payment_map: ${JSON.stringify(map[0] || null)}`);
  despuesPays.forEach((p) => console.log(`    pago MCM ${p.id}: status=${p.status} total=${p.total} refunded=${p.total_refunded}`));
  console.log(`    orden MCM: paid=${despuesOrder.paid} payment_status=${despuesOrder.payment_status} status=${despuesOrder.status}`);
  console.log(`    cheque Aloha: due=${despuesTicket.body?.totals?.due} paid=${despuesTicket.body?.totals?.paid} open=${despuesTicket.body?.open}`);
  ev.despues = { clover_payment: cp.body, map: map[0], pagos: despuesPays, orden: despuesOrder, aloha: despuesTicket.body?.totals };

  console.log(`\n  ══ VEREDICTO M2 ══`);
  if (rf.ok) {
    const p = despuesPays[0] || {};
    const statusCambio = p.status !== 'completed';
    const paidRecalc = Number(despuesOrder.paid) !== Number(antesOrder.paid);
    const alohaRevertido = despuesTicket.body?.totals?.paid !== antesTicket.body?.totals?.paid;
    console.log(`    payments.status cambió de 'completed'?  ${statusCambio ? 'SÍ' : 'NO'}`);
    console.log(`    total_refunded reflejado?               ${Number(p.total_refunded) > 0 ? 'SÍ' : 'NO'}`);
    console.log(`    orders.paid recalculado?                ${paidRecalc ? 'SÍ' : 'NO'}`);
    console.log(`    revertido en Omnivore?                  ${alohaRevertido ? 'SÍ' : 'NO'}`);
    if (!statusCambio && !paidRecalc && !alohaRevertido) console.log(`    ✗ M2 CONFIRMADO: el refund solo queda como escalar; ni el pago, ni la orden, ni el POS lo reflejan`);
  } else {
    console.log(`    NO VERIFICADO — el sandbox no aceptó ningún endpoint de refund`);
  }
  saveEvidence(`m2-${TOK}`, ev);
  const n = await L.assertNeighborsIntact('M2');
  console.log(`    vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
