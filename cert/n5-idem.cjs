/**
 * N5 · ¿Aloha honra el header `Idempotency-Id` en POST /payments?
 *
 * Importa porque el resume guard de `create-payment` (create-payment.ts:41-44)
 * es TODO-O-NADA: `due === 0 || paymentCount >= payments.length`. En un forward
 * de cheque partido (2+ pagos) donde el primero aterriza con lost-ACK, ambas
 * condiciones son falsas y el handler **re-postea payments[0]**. Lo único que
 * lo separa de un cobro duplicado es que Aloha respete `Idempotency-Id`.
 *
 * Prueba: mismo body, mismo header, dos veces. auto_close=false para que el
 * ticket siga abierto y `ticket_closed` no confunda el resultado.
 */
const L = require('./lib.cjs');
const { omni, db, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  const t = await omni.openTicket({ name: `CERT-${TOK}-N5`, table: libres[10], guestCount: 1 });
  if (!t.ok) { console.log('✗ open:', JSON.stringify(t.body?.errors)); await db.close(); return; }
  const tid = t.body.id;
  await omni.addItems(tid, [{ menu_item: '300015', quantity: 1, auto_send: true }]);
  const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
  if (!w.totals?.total) { console.log('✗ POS no totalizó — NO VERIFICADO'); await db.close(); return; }
  console.log(`ticket ${tid}  total=${w.totals.total}`);

  const IDEM = `cert-n5-${TOK}`;
  const body = { type: '3rd_party', tender_type: '28', amount: w.totals.total, tip: 100, auto_close: false };
  const res = [];
  for (let i = 1; i <= 2; i++) {
    const r = await omni.call('POST', `/tickets/${tid}/payments/`, body, IDEM);
    const pid = r.body?.id ?? null;
    console.log(`  POST #${i} (Idempotency-Id: ${IDEM}) → HTTP ${r.status}  payment_id=${pid ?? JSON.stringify(r.body?.errors)}`);
    res.push({ intento: i, status: r.status, payment_id: pid, errors: r.body?.errors });
    await sleep(2500);
  }

  await sleep(2500);
  const f = await omni.call('GET', `/tickets/${tid}/?fields=totals(due,paid,total,tips),payments(id,amount,tip)`);
  const pays = f.body?._embedded?.payments || [];
  console.log(`\n  Aloha final: ${JSON.stringify(f.body?.totals)}`);
  console.log(`  pagos en el ticket: ${pays.length} → ${JSON.stringify(pays.map((p) => ({ id: p.id, amount: p.amount, tip: p.tip })))}`);

  console.log(`\n  ══ VEREDICTO N5 ══`);
  const ids = res.map((r) => r.payment_id).filter(Boolean);
  if (pays.length >= 2 && ids.length === 2 && ids[0] !== ids[1]) {
    console.log(`    ✗ Aloha IGNORA Idempotency-Id: dos POST idénticos → dos pagos distintos (${ids.join(', ')})`);
    console.log(`      ⇒ el guard todo-o-nada de create-payment.ts:41 es la ÚNICA defensa,`);
    console.log(`        y no cubre el forward de cheque partido.`);
  } else if (ids.length === 2 && ids[0] === ids[1]) {
    console.log(`    ✓ Aloha HONRA Idempotency-Id: mismo payment_id en ambos POST (${ids[0]})`);
  } else {
    console.log(`    ~ resultado no concluyente — el 2º POST devolvió: ${JSON.stringify(res[1].errors)}`);
    console.log(`      pagos en el ticket: ${pays.length}`);
  }
  saveEvidence(`n5-${TOK}`, { ticket: tid, idempotency_id: IDEM, intentos: res, final: f.body?.totals, pagos: pays });
  const n = await L.assertNeighborsIntact('N5');
  console.log(`    vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
