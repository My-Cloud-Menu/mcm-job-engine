/**
 * M8 · reproducciones 2 y 3: el ítem anulado se sigue cobrando en Clover
 * (solo en el camino managed). Datos distintos en cada una para descartar
 * que sea artefacto de un ítem concreto.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, reconcile, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

async function setTS(on) {
  const c = await db.raw();
  await c.query(`update site_integrations set config = jsonb_set(config,'{omnivoreTableServiceEnabled}', $2::jsonb)
                  where site_id=$1 and provider='omnivore' and type='pos'`, [S, JSON.stringify(on)]);
}

async function caso({ tag, items, anular, table }) {
  const t = await omni.openTicket({ name: `CERT-${TOK}-${tag}`, table, guestCount: 2 });
  if (!t.ok) return { tag, error: 'open:' + JSON.stringify(t.body?.errors) };
  const tid = t.body.id;
  await omni.addItems(tid, items.map((m) => ({ menu_item: m, quantity: 1, auto_send: true })));
  let w = await omni.waitTotals(tid, 0);
  const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
  if (!r1.got) return { tag, ticket: tid, error: 'no llegó a MCM' };
  const mcmId = r1.got.id;
  const r2 = await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
  if (!r2.got) return { tag, ticket: tid, mcm: mcmId, error: 'no llegó a Clover' };
  const antes = w.totals.total;

  const tk = await omni.ticket(tid);
  const v = els(tk.body._embedded?.items).find((i) => String(i.name).includes(anular));
  if (!v) return { tag, ticket: tid, mcm: mcmId, error: `no encontré "${anular}" en el ticket` };
  const vd = await omni.voidItem(tid, v.id);
  if (!vd.ok) return { tag, ticket: tid, mcm: mcmId, error: 'void:' + JSON.stringify(vd.body?.errors) };
  w = await omni.waitTotals(tid, antes);

  const hashPrev = (await db.order(S, mcmId))?.clover_line_items_hash;
  await db.syncUntil(S, 'omnivore', 'fetch_recent_orders',
    async () => { const o = await db.order(S, mcmId); return L.cents(o.total) === Number(w.totals.total) ? o : null; }, { maxCycles: 4 });
  await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.clover_line_items_hash !== hashPrev ? o : null; }, { maxCycles: 3 });
  await sleep(5000);

  const m = await db.order(S, mcmId);
  const cl = (await clover.order(m.clover_ticket_id)).body;
  const rec = reconcile({ omnivoreTotals: w.totals, mcmOrder: m, cloverOrder: cl });
  const anuladas = (m.line_items || []).filter((li) => li.status === 'voided');
  return { tag, ticket: tid, mcm: mcmId, clover: m.clover_ticket_id,
    anulado: v.name, precio_anulado: v.price,
    pos_total: w.totals.total, mcm_total: L.cents(m.total), clover_total: cl?.total,
    delta: rec.clover_vs_mcm, lineas_anuladas_en_mcm: anuladas.length,
    sigue_en_clover: els(cl?.lineItems).some((li) => li.name === v.name),
    cuadra: rec.cuadra };
}

(async () => {
  const out = [];
  try {
    await setTS(true);
    console.log('omnivoreTableServiceEnabled = true (se restaura al final)\n');
    const tb = await omni.call('GET', '/tables/?limit=1000');
    const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
    for (const c of [
      { tag: 'M8b', items: ['300015', '310010', '300025'], anular: 'Elote', table: libres[90] },
      { tag: 'M8c', items: ['300110', '300155', '310170'], anular: 'Codorniu', table: libres[95] },
    ]) {
      const r = await caso(c); out.push(r);
      console.log(`\n── ${r.tag}`);
      if (r.error) { console.log(`   ✗ ${r.error}`); continue; }
      console.log(`   anulado: "${r.anulado}" ($${(r.precio_anulado / 100).toFixed(2)})`);
      console.log(`   POS=${r.pos_total}  MCM=${r.mcm_total}  Clover=${r.clover_total}  Δ=${r.delta}`);
      console.log(`   líneas anuladas retenidas en MCM: ${r.lineas_anuladas_en_mcm}   ¿sigue la línea en Clover?: ${r.sigue_en_clover ? 'SÍ' : 'no'}`);
      console.log(`   ${r.cuadra ? '✓ cuadra' : '✗ NO CUADRA — Clover cobra el ítem anulado'}`);
    }
  } finally {
    await setTS(false);
    console.log('\n[restaurado] omnivoreTableServiceEnabled = false');
    saveEvidence(`m8-reps-${TOK}`, out);
    const n = await L.assertNeighborsIntact('M8reps');
    console.log(`vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
    await db.close();
  }
})();
