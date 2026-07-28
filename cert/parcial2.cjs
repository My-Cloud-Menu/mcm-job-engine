/**
 * ¿Aloha acepta pagos PARCIALES? — barrido exhaustivo con tender SPC OTHER (979).
 *
 * Se relee `due` JUSTO antes de cada cobro (para descartar lectura vieja) y se varía
 * una sola cosa por caso: monto, tipo de pago y secuencia.
 */
const L = require('./lib.cjs');
const { omni, db, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const TENDER = '979'; // SPC OTHER

/** Sin mesa: `table` es opcional en Ticket<input> y el sandbox ya no tiene mesas libres.
 *  No afecta la prueba — lo que se mide es la aceptación del monto, no el floor. */
async function montar(tag, _mesa, items) {
  const t = await omni.openTicket({ name: `CERT-${TOK}-${tag}`, guestCount: 2, employee: '975', orderType: '4' }); // TO GO: sin mesa
  if (!t.ok) throw new Error('open: ' + JSON.stringify(t.body?.errors));
  const ai = await omni.addItems(t.body.id, items);
  if (!ai.ok) throw new Error('items: ' + JSON.stringify(ai.body?.errors));
  await omni.waitTotals(t.body.id, 0, { timeoutMs: 30000 });
  return t.body.id;
}
/** Relee el ticket JUSTO antes de cobrar — descarta que `due` esté viejo. */
async function dueFresco(tid) {
  const tk = await omni.call('GET', `/tickets/${tid}/?fields=totals(due,paid,total)`);
  return { due: Number(tk.body?.totals?.due), paid: Number(tk.body?.totals?.paid), total: Number(tk.body?.totals?.total) };
}
async function cobrar(tid, body) {
  const pg = await omni.call('POST', `/tickets/${tid}/payments/`, body);
  await sleep(2500);
  const t = await dueFresco(tid);
  return { ok: pg.ok, status: pg.status, id: pg.body?.id, err: pg.body?.errors?.[0], after: t };
}

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const mesas = [];
  const out = [];
  let mi = 30;
  console.log(`═══ Pagos parciales · tender SPC OTHER (${TENDER}) ═══\n`);

  const ITEMS = [{ menu_item: '300025', quantity: 1, auto_send: true }, { menu_item: '300015', quantity: 1, auto_send: true }];

  // ── 1..4 · fracciones distintas del due, tipo 3rd_party
  for (const [tag, frac] of [['25 %', .25], ['50 %', .5], ['90 %', .9], ['due − 1¢', null]]) {
    const tid = await montar('PA', mesas[mi += 2], ITEMS);
    const d = await dueFresco(tid);
    const amount = frac === null ? d.due - 1 : Math.round(d.due * frac);
    const r = await cobrar(tid, { type: '3rd_party', tender_type: TENDER, amount, tip: 0, comment: `CERT-${tag}` });
    console.log(`── 3rd_party ${tag}: due=${d.due} → amount=${amount}`);
    console.log(`   ${r.ok ? `✓ ACEPTADO (pago ${r.id})` : `✗ ${r.err?.error} — ${r.err?.description}`}   después: due=${r.after.due} paid=${r.after.paid}\n`);
    out.push({ caso: `3rd_party ${tag}`, tid, due: d.due, amount, ok: r.ok, err: r.err, after: r.after });
  }

  // ── 5 · parcial con type 'cash'
  {
    const tid = await montar('PB', mesas[mi += 2], ITEMS);
    const d = await dueFresco(tid);
    const amount = Math.round(d.due * .5);
    const r = await cobrar(tid, { type: 'cash', amount, tip: 0, comment: 'CERT-cash50' });
    console.log(`── cash 50 %: due=${d.due} → amount=${amount}`);
    console.log(`   ${r.ok ? `✓ ACEPTADO (pago ${r.id})` : `✗ ${r.err?.error} — ${r.err?.description}`}   después: due=${r.after.due} paid=${r.after.paid}\n`);
    out.push({ caso: 'cash 50 %', tid, due: d.due, amount, ok: r.ok, err: r.err, after: r.after });
  }

  // ── 6 · parcial con auto_close:false explícito
  {
    const tid = await montar('PC', mesas[mi += 2], ITEMS);
    const d = await dueFresco(tid);
    const amount = Math.round(d.due * .5);
    const r = await cobrar(tid, { type: '3rd_party', tender_type: TENDER, amount, tip: 0, auto_close: false, comment: 'CERT-noclose' });
    console.log(`── 3rd_party 50 % + auto_close:false: due=${d.due} → amount=${amount}`);
    console.log(`   ${r.ok ? `✓ ACEPTADO (pago ${r.id})` : `✗ ${r.err?.error} — ${r.err?.description}`}   después: due=${r.after.due} paid=${r.after.paid}\n`);
    out.push({ caso: '50 % auto_close:false', tid, due: d.due, amount, ok: r.ok, err: r.err, after: r.after });
  }

  // ── 7 · dos parciales seguidos que suman el due
  {
    const tid = await montar('PD', mesas[mi += 2], ITEMS);
    const d = await dueFresco(tid);
    const a1 = Math.round(d.due / 2), a2 = d.due - a1;
    const r1 = await cobrar(tid, { type: '3rd_party', tender_type: TENDER, amount: a1, tip: 0, auto_close: false, comment: 'CERT-seq1' });
    console.log(`── secuencia · pago 1 de 2: due=${d.due} → amount=${a1}`);
    console.log(`   ${r1.ok ? `✓ ACEPTADO (pago ${r1.id})` : `✗ ${r1.err?.error} — ${r1.err?.description}`}   después: due=${r1.after.due} paid=${r1.after.paid}`);
    const r2 = await cobrar(tid, { type: '3rd_party', tender_type: TENDER, amount: a2, tip: 0, comment: 'CERT-seq2' });
    console.log(`   pago 2 de 2 → amount=${a2}: ${r2.ok ? `✓ ACEPTADO` : `✗ ${r2.err?.error}`}   después: due=${r2.after.due} paid=${r2.after.paid}\n`);
    out.push({ caso: 'secuencia 2 parciales', tid, due: d.due, a1, a2, ok1: r1.ok, ok2: r2.ok, err1: r1.err, err2: r2.err, after: r2.after });
  }

  console.log('══ RESUMEN ══');
  out.forEach((o) => console.log(`  ${o.caso.padEnd(26)} ${o.ok ?? o.ok1 ? '✓' : '✗ ' + (o.err?.error ?? o.err1?.error ?? '')}`));
  const algunoOk = out.some((o) => o.ok || o.ok1);
  console.log(`\n  ${algunoOk ? '⚠ ALGÚN parcial SÍ pasó — hay que revisar la conclusión de N1/M1' : '⇒ NINGÚN parcial pasó: Aloha exige el due completo por API'}`);
  saveEvidence(`parcial2-${TOK}`, { casos: out });
  await db.close();
})();
