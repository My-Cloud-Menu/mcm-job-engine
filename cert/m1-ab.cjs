/**
 * M1 · Prueba A/B decisiva contra Aloha, con propina en los DOS casos.
 *
 *   A) amount = due       + tip = 300   ← lo que MCM DEBERÍA enviar
 *   B) amount = due − 300 + tip = 300   ← lo que MCM envía HOY
 *
 * Si A pasa y B falla, M1 es real y el fix es quitar la resta.
 * Si A TAMBIÉN falla, M1 es falso positivo y la causa es otra
 * (tender que no admite propina, 3rd_party con tip no soportado, etc.).
 *
 * Mismo tender (979 SPC OTHER, allows_tips=true), mismos ítems, mesas distintas.
 */
const L = require('./lib.cjs');
const { omni, db, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const TIP = 300;

async function montar(tag, mesa) {
  const t = await omni.openTicket({ name: `CERT-${TOK}-${tag}`, table: mesa, guestCount: 1, employee: '975' });
  if (!t.ok) throw new Error('open: ' + JSON.stringify(t.body?.errors));
  const tid = t.body.id;
  const ai = await omni.addItems(tid, [{ menu_item: '300025', quantity: 1, auto_send: true }]);
  if (!ai.ok) throw new Error('items: ' + JSON.stringify(ai.body?.errors));
  const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
  return { tid, due: Number(w.totals.due), total: Number(w.totals.total) };
}

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const mesas = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  const out = [];
  console.log('═══ M1 · A/B contra Aloha · tender 979 (SPC OTHER, allows_tips=true) ═══\n');

  const CASOS = [
    { tag: 'A', desc: 'amount = due COMPLETO + propina  (lo que MCM debería enviar)', resta: 0, mesa: mesas[5] },
    { tag: 'B', desc: 'amount = due − propina + propina (lo que MCM envía HOY)', resta: TIP, mesa: mesas[7] },
    { tag: 'C', desc: 'amount = due COMPLETO, sin propina (control ya conocido)', resta: 0, tip: 0, mesa: mesas[9] },
  ];

  for (const c of CASOS) {
    const m = await montar(c.tag, c.mesa);
    const tip = c.tip !== undefined ? c.tip : TIP;
    const amount = m.due - c.resta;
    console.log(`── ${c.tag} · ${c.desc}`);
    console.log(`   ticket ${m.tid} · due=${m.due}`);
    console.log(`   enviando: { amount: ${amount}, tip: ${tip}, tender_type: '979' }   (amount+tip = ${amount + tip})`);
    const pg = await omni.call('POST', `/tickets/${m.tid}/payments/`,
      { type: '3rd_party', tender_type: '979', amount, tip, comment: `CERT-M1-${c.tag}` });
    const err = pg.body?.errors?.[0];
    console.log(`   → HTTP ${pg.status}  ${pg.ok ? `ACEPTADO (pago ${pg.body?.id})` : `RECHAZADO: ${err?.error} — ${err?.description}`}`);
    await sleep(2500);
    const tk = await omni.ticket(m.tid);
    const t = tk.body?.totals || {};
    console.log(`   cheque tras el intento: due=${t.due} paid=${t.paid} tips=${t.tips} open=${tk.body?.open}\n`);
    out.push({ caso: c.tag, desc: c.desc, ticket: m.tid, due: m.due, amount, tip, ok: pg.ok, status: pg.status, error: err, totals: t });
  }

  const A = out.find((x) => x.caso === 'A'), B = out.find((x) => x.caso === 'B'), C = out.find((x) => x.caso === 'C');
  console.log('══ VEREDICTO ══');
  if (A?.ok && !B?.ok) {
    console.log('  ✗ M1 CONFIRMADO: Aloha SÍ acepta el pago completo con propina (A),');
    console.log('    y rechaza el mismo pago con la propina restada (B). La resta es el bug.');
  } else if (A?.ok && B?.ok) {
    console.log('  ⚠ M1 FALSO POSITIVO: Aloha acepta las DOS formas. La causa del fallo original es otra.');
  } else if (!A?.ok) {
    console.log(`  ⚠ M1 FALSO POSITIVO / causa distinta: Aloha rechaza TAMBIÉN el pago completo con propina.`);
    console.log(`    error de A: ${A?.error?.error} — ${A?.error?.description}`);
    console.log(`    ⇒ el problema no es la resta, es la propina en sí sobre este tender/tipo de pago.`);
  }
  console.log(`  control C (sin propina): ${C?.ok ? 'aceptado ✓' : 'RECHAZADO — ' + C?.error?.error}`);
  saveEvidence(`m1ab-${TOK}`, { casos: out });
  await db.close();
})();
