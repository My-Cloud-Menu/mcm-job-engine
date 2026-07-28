/**
 * 3 cheques cobrados EN EFECTIVO en el terminal Aloha, con ítems y montos distintos.
 * Cada uno aporta una reproducción a DOS hallazgos a la vez:
 *   M7 · el cheque ya cobrado se empuja igual a Clover como orden ABIERTA
 *   N3 · el tender real (CASH) se pierde: MCM lo graba como 'ecr-card'
 * El efectivo cierra limpio en Aloha (allows_tips=false, sin propina que confunda).
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

const CASOS = [
  { tag: 'D1', idx: 15, items: [{ menu_item: '300155', quantity: 1, auto_send: true }] },                                              // Arroz Verde $5
  { tag: 'D2', idx: 35, items: [{ menu_item: '300025', quantity: 1, auto_send: true }] },                                              // Elote $13
  { tag: 'D3', idx: 50, items: [{ menu_item: '300015', quantity: 1, auto_send: true }, { menu_item: '310170', quantity: 1, auto_send: true }] }, // Chips $6 + Codorniu $9
];

async function cobrarCash(tid, monto) {
  for (let i = 1; i <= 4; i++) {
    const pg = await omni.call('POST', `/tickets/${tid}/payments/`, { type: 'cash', amount: monto, tip: 0, auto_close: true });
    const err = pg.body?.errors?.[0]?.error;
    if (!pg.ok) console.log(`     intento ${i}: HTTP ${pg.status} ${err || ''}`);
    for (let j = 0; j < 10; j++) {
      const tk = await omni.ticket(tid);
      const t = tk.body?.totals || {};
      if (Number(t.due) === 0 && Number(t.paid) > 0) return { cerrado: true, totals: t, open: tk.body?.open };
      if (Number(t.paid) > 0 && !pg.ok) break; // aplicado sin ACK → no repetir
      await sleep(1500);
    }
    if (pg.ok || !['timeout', 'pos_not_responding_retry', 'pos_offline'].includes(err)) break;
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
    console.log(`\n── ${c.tag} · efectivo · mesa ${libres[c.idx]}`);
    const t = await omni.openTicket({ name: `CERT-${TOK}-${c.tag}`, table: libres[c.idx], guestCount: 1 });
    if (!t.ok) { console.log('   ✗ open'); continue; }
    const tid = t.body.id;
    const ai = await omni.addItems(tid, c.items);
    if (!ai.ok) { console.log('   ✗ addItems:', JSON.stringify(ai.body?.errors)); continue; }
    const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
    if (!w.totals?.total) { console.log('   ~ NO VERIFICADO: el POS no totalizó'); out.push({ tag: c.tag, no_verificado: 'POS no totalizó' }); continue; }
    console.log(`   ticket ${tid} total=${w.totals.total}`);

    const r = await cobrarCash(tid, w.totals.total);
    console.log(`   Aloha: due=${r.totals.due} paid=${r.totals.paid} open=${r.open}`);
    if (!r.cerrado) { console.log('   ~ NO VERIFICADO: el POS no liquidó'); out.push({ tag: c.tag, ticket: tid, no_verificado: 'POS no liquidó', aloha: r.totals }); continue; }

    const s1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
    if (!s1.got) { console.log('   ✗ no llegó a MCM'); continue; }
    const mcmId = s1.got.id;
    await sleep(4000);
    const m = await db.order(S, mcmId);
    const pays = await db.payments(S, mcmId);
    console.log(`   MCM ${mcmId}: payment_status=${m.payment_status} paid=${m.paid}`);
    pays.forEach((p) => console.log(`     pago ${p.id}: method='${p.method}' total=${p.total} tip=${p.tip}`));
    const tenderOk = /cash|efectivo/i.test(String(pays[0]?.method || ''));
    console.log(`   N3 tender: CASH → method='${pays[0]?.method ?? '—'}'  ${tenderOk ? '✓' : '✗ se pierde (queda como tarjeta)'}`);

    await db.syncUntil(S, 'clover', 'push_orders', async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
    await sleep(6000);
    const m2 = await db.order(S, mcmId);
    const cl = m2.clover_ticket_id ? (await clover.order(m2.clover_ticket_id)).body : null;
    const fantasma = cl?.paymentState === 'OPEN';
    console.log(`   M7 Clover: ${m2.clover_ticket_id || 'no se empujó'}${cl ? ` total=${cl.total} paymentState=${cl.paymentState}` : ''}  ${fantasma ? '✗ orden fantasma ABIERTA' : ''}`);
    out.push({ tag: c.tag, ticket: tid, aloha: r.totals, mcm: m, pagos: pays, clover: cl, tenderOk, fantasma });
  }

  const ok = out.filter((o) => o.clover !== undefined);
  console.log(`\n══ RESUMEN (${ok.length} reproducciones válidas) ══`);
  ok.forEach((o) => console.log(`  ${o.tag}: Aloha total=${o.aloha.total}¢ cobrado en efectivo · MCM method='${o.pagos[0]?.method}' · Clover ${o.clover?.total}¢ ${o.clover?.paymentState}`));
  console.log(`  M7 (orden fantasma en Clover): ${ok.filter((o) => o.fantasma).length}/${ok.length}`);
  console.log(`  N3 (tender preservado):        ${ok.filter((o) => o.tenderOk).length}/${ok.length}`);
  saveEvidence(`m7n3cash-${TOK}`, { casos: out });
  const n = await L.assertNeighborsIntact('M7-N3-cash');
  console.log(`  vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
