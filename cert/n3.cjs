/**
 * N3 · ¿MCM preserva el TENDER real y la PROPINA de un cheque cobrado en el terminal Aloha?
 *
 * Mecanismo previsto: `recordExternalOmnivorePaymentIfNeeded`
 * (upsert-orders.ts:76-102) inserta la fila de `payments` con `method: 'ecr-card'`
 * y `tip: '0.00'` **literales**, sin mirar el tender ni `totals.tips` del ticket.
 * Y `convertOmnivoreOrderToMCMOrder` no emite ningún campo de propina (probado en N4).
 *
 * Impacto: F11.2 (cuadre por tender) y F11.4 (reporte de propinas / tip-out).
 *
 * Cada rep usa un tender distinto para aislar la variable.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

const CASOS = [
  { tag: 'N3a', idx: 20, tender: '28', tenderName: 'VISA', tip: 300, items: [{ menu_item: '300155', quantity: 1, auto_send: true }] },
  { tag: 'N3b', idx: 40, tender: '27', tenderName: 'AMEX', tip: 450, items: [{ menu_item: '300015', quantity: 1, auto_send: true }] },
  { tag: 'N3c', idx: 55, tender: '7',  tenderName: 'ATH',  tip: 200, items: [{ menu_item: '300025', quantity: 1, auto_send: true }] },
];

/** Cobra reintentando el hipo del sandbox y espera a que Aloha liquide due=0. */
async function cobrarYCerrar(tid, monto, tender, tip) {
  for (let i = 1; i <= 4; i++) {
    const pg = await omni.call('POST', `/tickets/${tid}/payments/`,
      { type: '3rd_party', tender_type: tender, amount: monto, tip, auto_close: true });
    const err = pg.body?.errors?.[0]?.error;
    if (!pg.ok) console.log(`     intento ${i}: HTTP ${pg.status} ${err || ''}`);
    // sea ok o lost-ACK, esperar a que el POS liquide
    for (let j = 0; j < 12; j++) {
      const tk = await omni.ticket(tid);
      const t = tk.body?.totals || {};
      if (Number(t.due) === 0 && Number(t.paid) > 0) return { cerrado: true, totals: t, open: tk.body?.open };
      if (Number(t.paid) > 0 && !pg.ok) break; // el POS aplicó pero no liquidó → no repetir el cobro
      await sleep(1500);
    }
    if (pg.ok) break;
    if (!['timeout', 'pos_not_responding_retry', 'pos_offline'].includes(err)) break;
    await sleep(3000 * i);
  }
  const tk = await omni.ticket(tid);
  return { cerrado: Number(tk.body?.totals?.due) === 0, totals: tk.body?.totals || {}, open: tk.body?.open };
}

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  const out = [];

  for (const c of CASOS) {
    console.log(`\n── ${c.tag} · tender ${c.tenderName}(${c.tender}) · propina ${c.tip}¢ · mesa ${libres[c.idx]}`);
    const t = await omni.openTicket({ name: `CERT-${TOK}-${c.tag}`, table: libres[c.idx], guestCount: 2 });
    if (!t.ok) { console.log('   ✗ open:', JSON.stringify(t.body?.errors)); continue; }
    const tid = t.body.id;
    const ai = await omni.addItems(tid, c.items);
    if (!ai.ok) { console.log('   ✗ addItems:', JSON.stringify(ai.body?.errors)); continue; }
    const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
    if (!w.totals?.total) { console.log('   ✗ totals no se movieron (POS lento)'); out.push({ tag: c.tag, no_verificado: 'POS no totalizó' }); continue; }
    console.log(`   ticket ${tid} total=${w.totals.total}`);

    const r = await cobrarYCerrar(tid, w.totals.total, c.tender, c.tip);
    console.log(`   Aloha: due=${r.totals.due} paid=${r.totals.paid} tips=${r.totals.tips} open=${r.open}`);
    if (!r.cerrado) { console.log(`   ~ NO VERIFICADO: el POS no liquidó el cheque`); out.push({ tag: c.tag, ticket: tid, no_verificado: 'POS no liquidó', aloha: r.totals }); continue; }

    const s1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
    if (!s1.got) { console.log('   ✗ no llegó a MCM'); continue; }
    const mcmId = s1.got.id;
    await sleep(4000);
    const m = await db.order(S, mcmId);
    const pays = await db.payments(S, mcmId);
    console.log(`   MCM ${mcmId}: payment_status=${m.payment_status} paid=${m.paid} total=${m.total}`);
    pays.forEach((p) => console.log(`     pago ${p.id}: method='${p.method}' total=${p.total} tip=${p.tip} source='${p.source}'`));

    const pago = pays[0] || {};
    const tipOk = Math.round(Number(pago.tip || 0) * 100) === Number(r.totals.tips || 0);
    const tenderOk = String(pago.method || '').toLowerCase().includes(c.tenderName.toLowerCase());
    console.log(`   N3 tender : ${c.tenderName} → method='${pago.method ?? '—'}'   ${tenderOk ? '✓' : '✗ se pierde'}`);
    console.log(`   N3 propina: ${r.totals.tips}¢ → tip=${pago.tip ?? '—'}   ${tipOk ? '✓' : '✗ se pierde'}`);

    await db.syncUntil(S, 'clover', 'push_orders', async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
    await sleep(6000);
    const m2 = await db.order(S, mcmId);
    let cl = null;
    if (m2.clover_ticket_id) cl = (await clover.order(m2.clover_ticket_id)).body;
    console.log(`   M7 Clover: ${m2.clover_ticket_id || 'no se empujó'}${cl ? ` total=${cl.total} paymentState=${cl.paymentState}` : ''} ${cl?.paymentState === 'OPEN' ? '✗ fantasma' : ''}`);

    out.push({ tag: c.tag, ticket: tid, tender: c.tenderName, aloha: r.totals, mcm: m, pagos: pays, clover: cl, tenderOk, tipOk });
  }

  console.log(`\n══ RESUMEN ══`);
  out.filter((o) => o.pagos).forEach((o) =>
    console.log(`  ${o.tag}: tender ${o.tender}→'${o.pagos[0]?.method}' ${o.tenderOk ? 'ok' : 'PERDIDO'} · propina ${o.aloha.tips}¢→${o.pagos[0]?.tip} ${o.tipOk ? 'ok' : 'PERDIDA'} · Clover ${o.clover?.paymentState || '—'}`));
  saveEvidence(`n3-${TOK}`, { casos: out });
  const n = await L.assertNeighborsIntact('N3');
  console.log(`  vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
