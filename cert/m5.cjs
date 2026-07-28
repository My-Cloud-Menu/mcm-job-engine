/**
 * M5 · Ajuste de propina post-captura (pay-first, tip-later).
 *
 * El flujo dominante en servicio de mesa: el Flex captura la venta, el cliente
 * escribe la propina en el papel, y el ajuste entra después (batch/tip-adjust).
 *
 * Predicción: `upsert-payments.ts:140-181` detecta `tipChanged`, actualiza
 * `clover_payment_map` y `payments.tip/total`… y hace `continue`. NUNCA llama a
 * `maybeForwardPaymentToOmnivore` (que solo vive en la rama de INSERT, :383-390)
 * ⇒ el `totals.tips` de Aloha se queda como estaba, para siempre.
 *
 * Se cobra SIN propina para que el forward inicial funcione y el cheque cierre
 * (si se cobrara con propina, M1 lo tumbaría antes y no se podría aislar M5).
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

async function probeTipAdjust(paymentId, orderId, nuevoTip) {
  const intentos = [
    { label: 'POST /payments/{id} {tipAmount}', m: 'POST', p: `/payments/${paymentId}`, b: { tipAmount: nuevoTip } },
    { label: 'POST /orders/{o}/payments/{p} {tipAmount}', m: 'POST', p: `/orders/${orderId}/payments/${paymentId}`, b: { tipAmount: nuevoTip } },
    { label: 'PUT /payments/{id} {tipAmount}', m: 'PUT', p: `/payments/${paymentId}`, b: { tipAmount: nuevoTip } },
  ];
  const res = [];
  for (const it of intentos) {
    const r = await clover.call(it.m, it.p, it.b);
    res.push({ ...it, status: r.status, body: r.body });
    console.log(`     ${it.label} → HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
    if (r.status >= 200 && r.status < 300) {
      // confirmar que realmente cambió
      const chk = await clover.payment(paymentId);
      if (Number(chk.body?.tipAmount) === Number(nuevoTip)) return { ok: true, usado: it.label, intentos: res };
      console.log(`       (respondió ok pero tipAmount sigue en ${chk.body?.tipAmount})`);
    }
  }
  return { ok: false, intentos: res };
}

(async () => {
  const ev = { caso: 'M5 · tip adjust post-captura' };
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  const TABLE = libres[70];
  console.log(`═══ M5 · ajuste de propina post-captura · mesa ${TABLE} ═══`);

  const t = await omni.openTicket({ name: `CERT-${TOK}-M5`, table: TABLE, guestCount: 2 });
  if (!t.ok) { console.log('✗ open:', JSON.stringify(t.body?.errors)); process.exit(1); }
  const tid = t.body.id;
  await omni.addItems(tid, [{ menu_item: '300015', quantity: 1, auto_send: true }]); // Chips $6
  const w = await omni.waitTotals(tid, 0);
  const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
  if (!r1.got) { console.log('✗ no llegó a MCM'); process.exit(1); }
  const mcmId = r1.got.id;
  const r2 = await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
  const cloverId = r2.got.clover_ticket_id;
  console.log(`  ticket ${tid} → MCM ${mcmId} → Clover ${cloverId}  total=${w.totals.total}`);

  // 1) cobro SIN propina → el forward funciona y el cheque cierra
  const pay = await clover.pay(cloverId, { amount: w.totals.total, tip: 0, externalPaymentId: `CERT-${TOK}-M5` });
  console.log(`\n  1) cobro sin propina: pago Clover ${pay.body?.id}`);
  await db.syncUntil(S, 'clover', 'fetch_payments',
    async () => { const ps = await db.payments(S, mcmId); return ps.find((p) => p.pos_id === pay.body?.id) || null; }, { maxCycles: 4 });
  await sleep(10000);
  const t1 = await omni.ticket(tid);
  const p1 = (await db.payments(S, mcmId)).find((p) => p.pos_id === pay.body?.id);
  console.log(`     MCM pago: total=${p1?.total} tip=${p1?.tip} omni=${p1?.additional_properties?.omnivore_payment_id || '—'}`);
  console.log(`     cheque Aloha: due=${t1.body?.totals?.due} paid=${t1.body?.totals?.paid} tips=${t1.body?.totals?.tips} open=${t1.body?.open}`);
  ev.tras_cobro = { mcm_pago: p1, aloha: t1.body?.totals };
  if (!p1?.additional_properties?.omnivore_payment_id) console.log('     ⚠ el forward inicial no llegó — M5 no se puede aislar');

  // 2) el cliente escribe la propina en el papel → tip adjust en Clover
  const NUEVO_TIP = 200;
  console.log(`\n  2) tip adjust a ${NUEVO_TIP} centavos:`);
  const adj = await probeTipAdjust(pay.body.id, cloverId, NUEVO_TIP);
  ev.tip_adjust = adj;
  if (!adj.ok) { console.log(`     ⚠ ningún endpoint de tip-adjust funcionó → M5 NO VERIFICADO`); saveEvidence(`m5-${TOK}`, ev); await db.close(); return; }
  console.log(`     ✓ propina ajustada vía ${adj.usado}`);

  // 3) pull y estado final
  const since = new Date().toISOString();
  await db.syncUntil(S, 'clover', 'fetch_payments', async () => {
    const ps = await db.payments(S, mcmId); const p = ps.find((x) => x.pos_id === pay.body?.id);
    return Number(p?.tip) * 100 === NUEVO_TIP ? p : null;
  }, { maxCycles: 4 });
  await sleep(10000);
  const p2 = (await db.payments(S, mcmId)).find((p) => p.pos_id === pay.body?.id);
  const t2 = await omni.ticket(tid);
  const jobs = await db.jobs(S, since);
  const forwards = jobs.filter((j) => j.job_type === 'payment_injection' && j.integration === 'omnivore');
  console.log(`\n  3) después del ajuste:`);
  console.log(`     MCM pago: total=${p2?.total} tip=${p2?.tip}  (antes tip=${p1?.tip})`);
  console.log(`     cheque Aloha: paid=${t2.body?.totals?.paid} tips=${t2.body?.totals?.tips}  (antes tips=${t1.body?.totals?.tips})`);
  console.log(`     jobs payment_injection nuevos: ${forwards.length}`);
  ev.tras_ajuste = { mcm_pago: p2, aloha: t2.body?.totals, forwards: forwards.length };

  console.log(`\n  ══ VEREDICTO M5 ══`);
  const mcmActualizado = Number(p2?.tip) * 100 === NUEVO_TIP;
  const alohaActualizado = Number(t2.body?.totals?.tips) === NUEVO_TIP;
  console.log(`    MCM registró la propina nueva?   ${mcmActualizado ? 'SÍ' : 'NO'}  (tip=${p2?.tip})`);
  console.log(`    se reenvió a Omnivore?           ${forwards.length > 0 ? 'SÍ (' + forwards.length + ' jobs)' : 'NO'}`);
  console.log(`    Aloha refleja la propina?        ${alohaActualizado ? 'SÍ' : 'NO'}  (totals.tips=${t2.body?.totals?.tips})`);
  if (mcmActualizado && !alohaActualizado && forwards.length === 0) {
    console.log(`    ✗ M5 CONFIRMADO: MCM actualiza la propina pero NO la reenvía; el POS nunca se entera.`);
    console.log(`      El reparto de propinas al personal saldría de un totals.tips=${t2.body?.totals?.tips}.`);
  }
  saveEvidence(`m5-${TOK}`, ev);
  const n = await L.assertNeighborsIntact('M5');
  console.log(`    vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
