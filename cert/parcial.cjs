/**
 * ¿Aloha acepta pagos PARCIALES por API? Y ¿`full:true` cambia algo?
 *
 * Si acepta parciales, entonces el rechazo de M1-B no se explica por "monto corto"
 * y habría que revisar la conclusión. Si NO los acepta, queda claro que `amount`
 * debe cubrir el `due` completo — que es justo lo que M1 rompe.
 */
const L = require('./lib.cjs');
const { omni, db, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

async function montar(tag, mesa) {
  const t = await omni.openTicket({ name: `CERT-${TOK}-${tag}`, table: mesa, guestCount: 1, employee: '975' });
  if (!t.ok) throw new Error('open: ' + JSON.stringify(t.body?.errors));
  const ai = await omni.addItems(t.body.id, [{ menu_item: '300025', quantity: 1, auto_send: true }]);
  if (!ai.ok) throw new Error('items: ' + JSON.stringify(ai.body?.errors));
  const w = await omni.waitTotals(t.body.id, 0, { timeoutMs: 30000 });
  return { tid: t.body.id, due: Number(w.totals.due) };
}

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const mesas = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  const out = [];

  const CASOS = [
    { tag: 'P1', desc: 'parcial del 50 %, sin propina',            frac: 0.5, tip: 0 },
    { tag: 'P2', desc: 'parcial del 50 % + full:true',             frac: 0.5, tip: 0, full: true },
    { tag: 'P3', desc: 'completo + full:true + propina',           frac: 1,   tip: 300, full: true },
    { tag: 'P4', desc: 'parcial: amount+tip == due (M1-B exacto)', frac: null, tip: 300 },
  ];

  console.log('═══ ¿Aloha acepta pagos parciales? · tender 979 ═══\n');
  for (let i = 0; i < CASOS.length; i++) {
    const c = CASOS[i];
    const m = await montar(c.tag, mesas[12 + i * 2]);
    const amount = c.frac === null ? m.due - c.tip : Math.round(m.due * c.frac);
    const body = { type: '3rd_party', tender_type: '979', amount, tip: c.tip, comment: `CERT-${c.tag}` };
    if (c.full) body.full = true;
    console.log(`── ${c.tag} · ${c.desc}`);
    console.log(`   ticket ${m.tid} · due=${m.due}`);
    console.log(`   body: ${JSON.stringify(body)}`);
    const pg = await omni.call('POST', `/tickets/${m.tid}/payments/`, body);
    const err = pg.body?.errors?.[0];
    console.log(`   → HTTP ${pg.status} ${pg.ok ? `ACEPTADO (pago ${pg.body?.id})` : `RECHAZADO: ${err?.error} — ${err?.description}`}`);
    await sleep(2500);
    const tk = await omni.ticket(m.tid);
    const t = tk.body?.totals || {};
    console.log(`   cheque: due=${t.due} paid=${t.paid} tips=${t.tips} open=${tk.body?.open}\n`);
    out.push({ ...c, ticket: m.tid, due: m.due, amount, ok: pg.ok, status: pg.status, error: err, totals: t });
  }

  const p1 = out.find((x) => x.tag === 'P1'), p2 = out.find((x) => x.tag === 'P2'),
        p3 = out.find((x) => x.tag === 'P3'), p4 = out.find((x) => x.tag === 'P4');
  console.log('══ CONCLUSIÓN ══');
  console.log(`  ¿acepta parcial simple?          ${p1?.ok ? 'SÍ' : 'NO — ' + p1?.error?.error}`);
  console.log(`  ¿acepta parcial con full:true?   ${p2?.ok ? 'SÍ' : 'NO — ' + p2?.error?.error}`);
  console.log(`  ¿acepta completo con full:true?  ${p3?.ok ? 'SÍ' : 'NO — ' + p3?.error?.error}`);
  console.log(`  ¿acepta amount+tip == due?       ${p4?.ok ? 'SÍ' : 'NO — ' + p4?.error?.error}`);
  console.log();
  if (!p1?.ok && !p4?.ok) {
    console.log('  ⇒ Aloha exige que `amount` cubra el `due` COMPLETO. La propina va ADEMÁS, no dentro.');
    console.log('    Por eso M1-B falla: la resta deja el amount corto. Confirma M1 y N1 a la vez.');
  } else if (p1?.ok) {
    console.log('  ⇒ Aloha SÍ acepta parciales. Hay que revisar la explicación de M1 y de N1.');
  }
  saveEvidence(`parcial-${TOK}`, { casos: out });
  await db.close();
})();
