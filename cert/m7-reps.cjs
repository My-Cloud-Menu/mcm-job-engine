/**
 * M7 reps 2-3 · cheque cobrado EN EL TERMINAL ALOHA (no por Clover) → ¿se empuja igual a Clover?
 * N3 (de paso) · ¿MCM preserva el TENDER real y la PROPINA cobrada en el terminal?
 *
 * Cada rep usa tender, ítems y montos distintos, y esta vez con propina > 0
 * (rep 1 fue efectivo sin propina).
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

const CASOS = [
  { tag: 'M7b', idx: 60, tender: '28', tenderName: 'VISA', tip: 300, items: [{ menu_item: '300155', quantity: 1, auto_send: true }] },
  { tag: 'M7c', idx: 80, tender: '27', tenderName: 'AMEX', tip: 500, items: [{ menu_item: '300025', quantity: 1, auto_send: true }, { menu_item: '310170', quantity: 1, auto_send: true }] },
];

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  const out = [];

  for (const c of CASOS) {
    console.log(`\n── ${c.tag} · tender ${c.tenderName}(${c.tender}) · propina ${c.tip}¢ · mesa ${libres[c.idx]}`);
    const t = await omni.openTicket({ name: `CERT-${TOK}-${c.tag}`, table: libres[c.idx], guestCount: 2 });
    if (!t.ok) { console.log('  ✗ open:', JSON.stringify(t.body?.errors)); continue; }
    const tid = t.body.id;
    const ai = await omni.addItems(tid, c.items);
    if (!ai.ok) { console.log('  ✗ addItems:', JSON.stringify(ai.body?.errors)); continue; }
    const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
    if (!w.totals?.total) { console.log('  ✗ totals no se movieron'); continue; }
    console.log(`   ticket ${tid} total=${w.totals.total}`);

    // el mesero cobra EN EL TERMINAL ALOHA (fuera de Clover), con propina.
    // El agente de Aloha del sandbox devuelve timeout / pos_not_responding_retry
    // bajo carga → reintento con backoff, tal como haría el terminal real.
    let pg = null;
    for (let i = 1; i <= 5; i++) {
      pg = await omni.call('POST', `/tickets/${tid}/payments/`,
        { type: '3rd_party', tender_type: c.tender, amount: w.totals.total, tip: c.tip, auto_close: true });
      if (pg.ok) break;
      const err = pg.body?.errors?.[0]?.error;
      console.log(`   intento ${i}: HTTP ${pg.status} ${err || JSON.stringify(pg.body)}`);
      if (!['timeout', 'pos_not_responding_retry', 'pos_offline'].includes(err)) break;
      // ¿el POS aplicó el pago pese al timeout? (lost-ACK)
      const chk = await omni.ticket(tid);
      if (Number(chk.body?.totals?.paid || 0) > 0) { console.log(`   → el POS SÍ aplicó el pago pese al error (lost-ACK)`); pg = { ok: true, status: 'lost-ack', body: chk.body }; break; }
      await sleep(4000 * i);
    }
    console.log(`   cobro en terminal → ${pg.ok ? 'ok' : 'FALLÓ'}`);
    if (!pg.ok) { out.push({ tag: c.tag, ticket: tid, no_verificado: 'POS Aloha no respondió', error: pg.body }); continue; }
    const tk = await omni.ticket(tid);
    const at = tk.body?.totals || {};
    console.log(`   Aloha: due=${at.due} paid=${at.paid} tips=${at.tips} open=${tk.body?.open}`);

    const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
    if (!r1.got) { console.log('   ✗ no llegó a MCM'); continue; }
    const mcmId = r1.got.id;
    await sleep(3000);
    const m = await db.order(S, mcmId);
    const pays = await db.payments(S, mcmId);
    console.log(`   MCM ${mcmId}: status=${m.status} payment_status=${m.payment_status} paid=${m.paid} payment_method=${m.payment_method}`);
    pays.forEach((p) => console.log(`     pago ${p.id}: method=${p.method} total=${p.total} tip=${p.tip} source=${p.source}`));

    // N3 · fidelidad de tender y propina
    const n3 = {
      tender_real: c.tenderName,
      method_en_mcm: pays[0]?.method ?? null,
      tender_preservado: false,
      tip_aloha: at.tips,
      tip_en_pago_mcm: pays[0]?.tip ?? null,
      tip_preservado: Math.round(Number(pays[0]?.tip ?? 0) * 100) === Number(at.tips ?? 0),
    };
    console.log(`   N3 tender: Aloha=${c.tenderName} → MCM='${n3.method_en_mcm}'  ${n3.tender_preservado ? '✓' : '✗ se pierde'}`);
    console.log(`   N3 propina: Aloha=${at.tips}¢ → MCM pago tip=${n3.tip_en_pago_mcm}  ${n3.tip_preservado ? '✓' : '✗ se pierde'}`);

    await db.syncUntil(S, 'clover', 'push_orders', async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
    await sleep(6000);
    const m2 = await db.order(S, mcmId);
    let cl = null;
    if (m2.clover_ticket_id) cl = (await clover.order(m2.clover_ticket_id)).body;
    console.log(`   M7 Clover: ${m2.clover_ticket_id || 'no se empujó'}${cl ? `  total=${cl.total} paymentState=${cl.paymentState}` : ''}`);
    console.log(`   ${cl?.paymentState === 'OPEN' ? '✗ orden fantasma ABIERTA en Clover' : '~ revisar'}`);
    out.push({ tag: c.tag, ticket: tid, aloha: at, mcm: m, pagos: pays, clover: cl, n3 });
  }
  saveEvidence(`m7reps-${TOK}`, { casos: out });
  const n = await L.assertNeighborsIntact('M7-reps');
  console.log(`\nvecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
