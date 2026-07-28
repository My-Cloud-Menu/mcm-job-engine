/**
 * F9.A5 bis · el MISMO void, pero con `omnivoreTableServiceEnabled = true`.
 *
 * Con el flag encendido, una orden dine-in con mesa entra al MERGE managed en vez
 * del overwrite. El merge CONSERVA la línea anulada con `status:'voided'` en vez de
 * quitarla, y `buildCloverLineItemsWithTaxes` itera `order.line_items` SIN filtrar
 * por ese status ⇒ predicción M8: el ítem anulado se sigue cobrando en Clover.
 *
 * El flag se restaura al terminar, pase lo que pase.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, reconcile, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

async function setTableService(on) {
  const c = await db.raw();
  await c.query(
    `update site_integrations
        set config = jsonb_set(config,'{omnivoreTableServiceEnabled}', $2::jsonb)
      where site_id = $1 and provider='omnivore' and type='pos'`, [S, JSON.stringify(on)]);
  const r = await c.query(
    `select config->>'omnivoreTableServiceEnabled' v from site_integrations
      where site_id=$1 and provider='omnivore' and type='pos'`, [S]);
  return r.rows[0].v;
}

async function snap(label, tid, mcmId, tot) {
  const m = await db.order(S, mcmId);
  const cl = m?.clover_ticket_id ? (await clover.order(m.clover_ticket_id)).body : null;
  const rec = reconcile({ omnivoreTotals: tot, mcmOrder: m, cloverOrder: cl });
  const vivas = (m?.line_items || []).filter((li) => li.status !== 'voided');
  const anuladas = (m?.line_items || []).filter((li) => li.status === 'voided');
  console.log(`\n── ${label}`);
  console.log(`   POS total=${tot.total} items=${tot.items}`);
  console.log(`   MCM total=${m?.total}  líneas: ${vivas.length} vivas + ${anuladas.length} anuladas`);
  if (anuladas.length) console.log(`     anuladas: ${anuladas.map((li) => `${li.name} $${li.price} (${li.additional_properties?.omnivore?.void_reason || 'voided'})`).join(', ')}`);
  console.log(`   Clover total=${cl?.total}: ${els(cl?.lineItems).map((li) => `${li.name}=${li.price}`).join(' | ')}`);
  console.log(`   ${rec.cuadra ? '✓ CUADRA' : `✗ NO CUADRA  Clover−MCM=${rec.clover_vs_mcm}  Σlíneas−total=${rec.clover_lines_vs_total}`}`);
  return { label, mcm: m, clover: cl, rec, vivas: vivas.length, anuladas: anuladas.length,
           anuladas_detalle: anuladas.map((li) => ({ name: li.name, price: li.price, status: li.status })) };
}

(async () => {
  const ev = { caso: 'F9.A5bis · void con table-service ON (M8)', pasos: [] };
  let restored = false;
  const restore = async () => { if (!restored) { restored = true; const v = await setTableService(false); console.log(`\n[restaurado] omnivoreTableServiceEnabled = ${v}`); } };
  process.on('exit', () => {});
  try {
    const v = await setTableService(true);
    console.log(`omnivoreTableServiceEnabled = ${v}  (se restaura al final)\n`);

    const tb = await omni.call('GET','/tables/?limit=1000');
    const libres = els(tb.body?._embedded?.tables).filter((x)=>x.available).map((x)=>String(x.id));
    const TABLE = process.env.M8_TABLE || libres[60];
    const t = await omni.openTicket({ name: `CERT-${TOK}-M8`, table: TABLE, guestCount: 2 });
    if (!t.ok) { console.log('✗ open:', JSON.stringify(t.body?.errors)); await restore(); process.exit(1); }
    const tid = t.body.id;
    console.log(`ticket ${tid} · mesa ${TABLE}`);

    await omni.addItems(tid, [
      { menu_item: '300015', quantity: 1, auto_send: true },   // Chips $6
      { menu_item: '300025', quantity: 1, auto_send: true },   // Elote $13
      { menu_item: '300110', quantity: 1, auto_send: true },   // Refritos $6  ← se anulará
    ]);
    let w = await omni.waitTotals(tid, 0);
    const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
    if (!r1.got) { console.log('✗ no llegó a MCM'); await restore(); process.exit(1); }
    const mcmId = r1.got.id;
    console.log(`MCM orden ${mcmId}  managed=${r1.got.additional_properties?.omnivore_managed ?? '(ausente)'}`);
    await db.syncUntil(S, 'clover', 'push_orders',
      async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 3 });
    ev.pasos.push(await snap('ANTES del void', tid, mcmId, w.totals));

    // void del Refritos
    const tk = await omni.ticket(tid);
    const victima = els(tk.body._embedded?.items).find((i) => String(i.name).includes('Refritos'));
    console.log(`\n   [void] "${victima?.name}" id=${victima?.id} price=${victima?.price}`);
    const vd = await omni.voidItem(tid, victima.id);
    console.log(`   void → HTTP ${vd.status} ${vd.ok ? 'ok' : JSON.stringify(vd.body?.errors)}`);
    w = await omni.waitTotals(tid, w.totals.total);

    const hashPrev = (await db.order(S, mcmId))?.clover_line_items_hash;
    await db.syncUntil(S, 'omnivore', 'fetch_recent_orders',
      async () => { const o = await db.order(S, mcmId); return L.cents(o.total) === Number(w.totals.total) ? o : null; }, { maxCycles: 3 });
    await db.syncUntil(S, 'clover', 'push_orders',
      async () => { const o = await db.order(S, mcmId); return o?.clover_line_items_hash !== hashPrev ? o : null; }, { maxCycles: 3 });
    await sleep(5000);
    const despues = await snap('DESPUÉS del void', tid, mcmId, w.totals);
    ev.pasos.push(despues);

    console.log('\n  ══ VEREDICTO M8 ══');
    if (despues.anuladas > 0 && !despues.rec.cuadra) {
      console.log(`    ✗ CONFIRMADO: la línea anulada sigue en MCM (status=voided) y Clover cobra de más`);
      console.log(`      Clover=${despues.rec.clover_order_total} vs MCM=${despues.rec.mcm_total_cents}  Δ=${despues.rec.clover_vs_mcm}`);
    } else if (despues.anuladas > 0 && despues.rec.cuadra) {
      console.log(`    ~ la línea anulada se conserva en MCM pero el total CUADRA — el push la excluye o el absorber la compensa`);
    } else {
      console.log(`    ✓ NO REPRODUCIDO: la línea anulada no quedó en MCM (${despues.anuladas} anuladas) y cuadra`);
    }
    saveEvidence(`f9-m8-${TOK}`, ev);
    const n = await L.assertNeighborsIntact('M8');
    console.log(`    vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  } finally {
    await restore();
    await db.close();
  }
})();
