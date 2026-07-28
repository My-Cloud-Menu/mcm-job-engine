/**
 * ¿Aloha acepta pagos PARCIALES? — usando cheques YA ABIERTOS en la location
 * (el sandbox se quedó sin mesas para abrir nuevos).
 *
 * Por cada cheque se relee el `due` EXACTO justo antes del cobro y se prueba una
 * variante. Tender SPC OTHER (979) salvo donde se indique.
 */
const L = require('./lib.cjs');
const { omni, db, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const TENDER = '979';

async function totals(tid) {
  const tk = await omni.call('GET', `/tickets/${tid}/?fields=totals(due,paid,total,tips),open`);
  return { ...(tk.body?.totals || {}), open: tk.body?.open };
}

(async () => {
  // cheques abiertos con saldo, creados por la certificación
  const r = await omni.call('GET', '/tickets/?where=eq(open,true)&limit=100');
  const abiertos = [];
  for (const t of els(r.body?._embedded?.tickets)) {
    const d = await totals(t.id);
    if (Number(d.due) > 500 && Number(d.paid) === 0) abiertos.push({ id: t.id, ...d });
    if (abiertos.length >= 8) break;
  }
  console.log(`cheques abiertos con saldo disponibles: ${abiertos.length}\n`);
  if (abiertos.length < 5) { console.log('✗ no hay suficientes'); await db.close(); return; }

  const VARIANTES = [
    { tag: '25 % del due',                 body: (d) => ({ type: '3rd_party', tender_type: TENDER, amount: Math.round(d * .25), tip: 0 }) },
    { tag: '50 % del due',                 body: (d) => ({ type: '3rd_party', tender_type: TENDER, amount: Math.round(d * .5), tip: 0 }) },
    { tag: 'due − 1 centavo',              body: (d) => ({ type: '3rd_party', tender_type: TENDER, amount: d - 1, tip: 0 }) },
    { tag: '50 % + auto_close:false',      body: (d) => ({ type: '3rd_party', tender_type: TENDER, amount: Math.round(d * .5), tip: 0, auto_close: false }) },
    { tag: '50 % en efectivo (type cash)', body: (d) => ({ type: 'cash', amount: Math.round(d * .5), tip: 0 }) },
    { tag: 'due EXACTO (control)',         body: (d) => ({ type: '3rd_party', tender_type: TENDER, amount: d, tip: 0 }) },
  ];

  const out = [];
  for (let i = 0; i < VARIANTES.length && i < abiertos.length; i++) {
    const v = VARIANTES[i], tk = abiertos[i];
    const antes = await totals(tk.id);           // ← due EXACTO, releído ahora mismo
    const body = { ...v.body(Number(antes.due)), comment: `CERT-${TOK}-${i}` };
    console.log(`── ${v.tag}`);
    console.log(`   ticket ${tk.id} · due leído ahora = ${antes.due} (total ${antes.total}, paid ${antes.paid})`);
    console.log(`   body: ${JSON.stringify(body)}`);
    const pg = await omni.call('POST', `/tickets/${tk.id}/payments/`, body);
    const err = pg.body?.errors?.[0];
    await sleep(2500);
    const desp = await totals(tk.id);
    console.log(`   → HTTP ${pg.status} ${pg.ok ? `✓ ACEPTADO (pago ${pg.body?.id})` : `✗ ${err?.error} — ${err?.description}`}`);
    console.log(`   después: due=${desp.due} paid=${desp.paid} open=${desp.open}\n`);
    out.push({ variante: v.tag, ticket: tk.id, due_antes: antes.due, amount: body.amount, ok: pg.ok, status: pg.status, error: err, despues: desp });
  }

  console.log('══ RESUMEN ══');
  out.forEach((o) => console.log(`  ${o.variante.padEnd(30)} due=${String(o.due_antes).padStart(5)} amount=${String(o.amount).padStart(5)} → ${o.ok ? '✓ ACEPTADO' : '✗ ' + o.error?.error}`));
  const parciales = out.filter((o) => o.amount < o.due_antes);
  const okParciales = parciales.filter((o) => o.ok);
  console.log(`\n  parciales probados: ${parciales.length} · aceptados: ${okParciales.length}`);
  console.log(`  ${okParciales.length ? '⚠ Aloha SÍ acepta parciales — hay que revisar N1 y la explicación de M1' : '⇒ Aloha NO acepta parciales por API: `amount` debe cubrir el `due` completo'}`);
  saveEvidence(`parcial3-${TOK}`, { casos: out });
  await db.close();
})();
