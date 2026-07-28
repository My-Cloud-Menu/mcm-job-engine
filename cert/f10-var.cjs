/**
 * F10 · variantes que rompen el camino suplementario.
 *  10.2 · agregar DOS VECES el mismo ítem tras el pago → ¿append idempotente?
 *  10.4 · QUITAR un ítem tras el pago (delta negativo puro) → ¿error visible?
 *  10.7 · tres ediciones seguidas tras el pago → ¿se corrompe el manifiesto?
 *  7.12 · comp 100 % con el formato de descuento correcto (re-corrida)
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const out = [];
let mesas = [];

async function montar(tag, mesaIdx, items) {
  const t = await omni.openTicket({ name: `CERT-${TOK}-${tag}`, table: mesas[mesaIdx], guestCount: 2 });
  if (!t.ok) throw new Error('open: ' + JSON.stringify(t.body?.errors));
  const tid = t.body.id;
  const ai = await omni.addItems(tid, items);
  if (!ai.ok) throw new Error('addItems: ' + JSON.stringify(ai.body?.errors));
  const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
  const m = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
  if (!m.got) throw new Error('no llegó a MCM');
  await db.syncUntil(S, 'clover', 'push_orders', async () => { const o = await db.order(S, m.got.id); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
  await sleep(5000);
  const o = await db.order(S, m.got.id);
  return { tid, mcmId: m.got.id, cloverId: o.clover_ticket_id, posTotal: w.totals.total, o };
}
async function cobrar(cloverId, cents) {
  const p = await clover.pay(cloverId, { amount: cents, tip: 0, externalPaymentId: `cert${Date.now()%1e8}` });
  await sleep(3000);
  await db.syncUntil(S, 'clover', 'fetch_payments', async () => true, { maxCycles: 1 }).catch(() => {});
  return p;
}
const manif = (o) => o?.additional_properties?.clover_supplemental ?? null;

async function caso(tag, titulo, fn) {
  console.log(`\n── ${tag} · ${titulo}`);
  try { const r = await fn(); out.push({ tag, titulo, ...r }); }
  catch (e) { console.log(`   ~ ${String(e.message || e).slice(0, 130)}`); out.push({ tag, titulo, no_verificado: String(e.message || e).slice(0, 200) }); }
}

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  mesas = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  console.log(`═══ F10 variantes · ${mesas.length} mesas libres ═══`);

  // ── 7.12 (re-corrida) · comp 100 % con el formato correcto: [{discount}] sin value
  await caso('7.12', 'comp / cortesía 100 % (formato de descuento correcto)', async () => {
    const b = await montar('C100', 20, [{ menu_item: '300025', quantity: 1, auto_send: true }]);
    console.log(`   base: POS=${b.posTotal} MCM=${b.mcmId} Clover=${b.cloverId}`);
    const d = await omni.call('POST', `/tickets/${b.tid}/discounts/`, [{ discount: 'c83' }]);
    console.log(`   descuento c83 (NBO/Comp 100 %) → HTTP ${d.status} ${d.ok ? '' : JSON.stringify(d.body?.errors)}`);
    const w = await omni.waitTotals(b.tid, b.posTotal, { timeoutMs: 25000 });
    console.log(`   POS tras el comp: total=${w.totals.total} descuentos=${w.totals.discounts} due=${w.totals.due}`);
    await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', async () => {
      const o = await db.order(S, b.mcmId); return Math.round(Number(o.total) * 100) === Number(w.totals.total) ? o : null;
    }, { maxCycles: 3 });
    await db.syncUntil(S, 'clover', 'push_orders', async () => true, { maxCycles: 2 }).catch(() => {});
    await sleep(6000);
    const o = await db.order(S, b.mcmId);
    const cl = (await clover.order(o.clover_ticket_id)).body;
    const sobre = Number(cl?.total || 0) - Number(w.totals.total);
    console.log(`   MCM total=${o.total}  ·  Clover ${o.clover_ticket_id} total=${cl?.total}`);
    console.log(`   ${sobre > 0 ? `✗ Clover cobra ${sobre}¢ por una cortesía del 100 % — el cliente paga la comida regalada` : '✓ cuadra'}`);
    return { ticket: b.tid, mcm: b.mcmId, pos_total: w.totals.total, clover_total: cl?.total, sobrecobro: sobre };
  });

  // ── 10.4 · quitar un ítem DESPUÉS del pago (delta negativo puro)
  await caso('10.4', 'quitar un ítem después del pago (delta negativo)', async () => {
    const b = await montar('NEG', 24, [
      { menu_item: '300025', quantity: 1, auto_send: true },
      { menu_item: '300015', quantity: 1, auto_send: true }]);
    console.log(`   base: POS=${b.posTotal} MCM=${b.mcmId} Clover=${b.cloverId}`);
    const pg = await cobrar(b.cloverId, b.posTotal);
    console.log(`   cobro en Clover ${b.posTotal}¢ → HTTP ${pg.status}`);
    await sleep(4000);
    const it = await omni.call('GET', `/tickets/${b.tid}/?fields=items(id,name)`);
    const victima = els(it.body?._embedded?.items)[0];
    const dl = await omni.call('DELETE', `/tickets/${b.tid}/items/${victima.id}/`, { void_type: omni.cfg.voidType });
    console.log(`   void de "${victima.name}" tras el pago → HTTP ${dl.status} ${dl.ok ? '' : JSON.stringify(dl.body?.errors)}`);
    const w = await omni.waitTotals(b.tid, b.posTotal, { timeoutMs: 25000 });
    console.log(`   POS ahora: ${w.totals.total} (antes ${b.posTotal})`);
    await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', async () => {
      const o = await db.order(S, b.mcmId); return Math.round(Number(o.total) * 100) === Number(w.totals.total) ? o : null;
    }, { maxCycles: 3 });
    await db.syncUntil(S, 'clover', 'push_orders', async () => true, { maxCycles: 2 }).catch(() => {});
    await sleep(8000);
    const o = await db.order(S, b.mcmId);
    console.log(`   MCM pos_injection_error: ${o.pos_injection_error ?? o.additional_properties?.pos_injection_error ?? '—'}`);
    console.log(`   manifiesto suplementario: ${manif(o) ? JSON.stringify(manif(o)).slice(0, 180) : 'no'}`);
    const cl = (await clover.order(b.cloverId)).body;
    console.log(`   Clover ${b.cloverId}: total=${cl?.total} paymentState=${cl?.paymentState} líneas=${els(cl?.lineItems).length}`);
    const visible = !!(o.pos_injection_error || o.issues);
    console.log(`   ${visible ? '✓ el delta negativo quedó visible' : '✗ el delta negativo NO deja rastro: el cliente pagó de más y nadie se entera'}`);
    return { ticket: b.tid, mcm: b.mcmId, pos_antes: b.posTotal, pos_despues: w.totals.total, clover_total: cl?.total, error_visible: visible, manifiesto: manif(o) };
  });

  // ── 10.2 · agregar DOS VECES el mismo ítem tras el pago
  await caso('10.2', 'agregar dos veces el mismo ítem tras el pago', async () => {
    const b = await montar('DUP', 28, [{ menu_item: '300015', quantity: 1, auto_send: true }]);
    console.log(`   base: POS=${b.posTotal} MCM=${b.mcmId} Clover=${b.cloverId}`);
    const pg = await cobrar(b.cloverId, b.posTotal);
    console.log(`   cobro ${b.posTotal}¢ → HTTP ${pg.status}`);
    await sleep(4000);
    let prev = b.posTotal;
    for (let i = 1; i <= 2; i++) {
      const a = await omni.addItems(b.tid, [{ menu_item: '300155', quantity: 1, auto_send: true }]);
      const w = await omni.waitTotals(b.tid, prev, { timeoutMs: 25000 });
      console.log(`   add #${i} ("Arroz Verde") → HTTP ${a.status} · POS total ${prev} → ${w.totals.total}`);
      prev = w.totals.total;
      await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', async () => {
        const o = await db.order(S, b.mcmId); return Math.round(Number(o.total) * 100) === Number(prev) ? o : null;
      }, { maxCycles: 3 });
      await db.syncUntil(S, 'clover', 'push_orders', async () => true, { maxCycles: 2 }).catch(() => {});
      await sleep(7000);
    }
    const o = await db.order(S, b.mcmId);
    const mf = manif(o);
    const sup = mf?.supplements ?? [];
    console.log(`   suplementos en el manifiesto: ${sup.length}`);
    let sumaSup = 0;
    for (const s of sup) {
      const cl = (await clover.order(s.clover_order_id)).body;
      sumaSup += Number(cl?.total || 0);
      console.log(`     ${s.clover_order_id}: total=${cl?.total} sig=${s.delta_signature} keys=${JSON.stringify(s.delta_keys)}`);
    }
    const clP = (await clover.order(b.cloverId)).body;
    const totalClover = Number(clP?.total || 0) + sumaSup;
    console.log(`   Σ Clover (primaria ${clP?.total} + suplementos ${sumaSup}) = ${totalClover}  ·  POS = ${prev}  ·  MCM = ${Math.round(Number(o.total) * 100)}`);
    const ok = totalClover === Number(prev);
    console.log(`   ${ok ? '✓ los dos agregados se facturaron una sola vez cada uno' : `✗ descuadre de ${totalClover - Number(prev)}¢`}`);
    return { ticket: b.tid, mcm: b.mcmId, pos_final: prev, suplementos: sup.length, clover_total: totalClover, ok };
  });

  console.log(`\n══ F10 variantes · resumen ══`);
  out.forEach((r) => console.log(`  ${r.tag}: ${r.no_verificado ? 'NO VERIFICADO — ' + r.no_verificado : 'corrido'}`));
  saveEvidence(`f10var-${TOK}`, { casos: out });
  const nb = await L.assertNeighborsIntact('F10-var');
  console.log(`  vecinos intactos: ${nb.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
