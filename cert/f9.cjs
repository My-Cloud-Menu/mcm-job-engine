/**
 * F9 · Ciclo de vida completo con ediciones desde Omnivore.
 * Una sola mesa, mutaciones secuenciales, cuadre triple tras CADA paso.
 *
 * Respeta el lag de Aloha (~1.5 s medido) entre aceptar la mutación y reflejarla
 * en `totals`: sin esa espera las aserciones leen el estado viejo.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, reconcile } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const pasos = [];

async function cuadre(label, tid, mcmId, tot) {
  const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders',
    async () => { const o = await db.order(S, mcmId); return o && L.cents(o.total) === Number(tot.total) ? o : null; },
    { maxCycles: 3 });
  const hashPrev = pasos.length ? pasos[pasos.length - 1].hash : null;
  const r2 = await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id && o.clover_line_items_hash !== hashPrev ? o : null; },
    { maxCycles: 3 });
  const m2 = r2.got || r1.got || await db.order(S, mcmId);
  const cl = m2?.clover_ticket_id ? (await clover.order(m2.clover_ticket_id)).body : null;
  const rec = reconcile({ omnivoreTotals: tot, mcmOrder: m2, cloverOrder: cl });
  const lineas = els(cl?.lineItems).map((li) => `${li.name}=${li.price}+${els(li.taxRates).reduce((a, t) => a + (t.taxAmount || 0), 0)}`);
  pasos.push({ paso: label, hash: m2?.clover_line_items_hash,
    omni: { items: tot.items, tax: tot.tax, svc: tot.service_charges, disc: tot.discounts, total: tot.total },
    mcm_total: m2?.total, mcm_lineas: (m2?.line_items || []).length,
    clover_total: cl?.total, clover_lineas: lineas, cuadra: rec.cuadra, rec });
  console.log(`\n── ${label}`);
  console.log(`   POS: items=${tot.items} tax=${tot.tax} svc=${tot.service_charges} disc=${tot.discounts} → total=${tot.total}`);
  console.log(`   MCM total=${m2?.total} (${(m2?.line_items || []).length} líneas)   Clover total=${cl?.total}`);
  console.log(`   Clover: ${lineas.join(' | ')}`);
  console.log(`   ${rec.cuadra ? '✓ CUADRA' : `✗ NO CUADRA  MCM−POS=${rec.mcm_vs_omnivore}  Clover−MCM=${rec.clover_vs_mcm}  Σlíneas−total=${rec.clover_lines_vs_total}`}`);
}

(async () => {
  const TABLE = process.env.F9_TABLE || '210';
  console.log(`═══ F9 · ciclo de vida con ediciones · mesa ${TABLE} ═══`);
  const t = await omni.openTicket({ name: `CERT-${TOK}-F9`, table: TABLE, guestCount: 3 });
  if (!t.ok) { console.log('✗ open:', JSON.stringify(t.body?.errors)); process.exit(1); }
  const tid = t.body.id;
  console.log(`ticket ${tid}`);
  let prev = 0;

  await omni.addItems(tid, [
    { menu_item: '300015', quantity: 1, auto_send: true },   // Chips & Salsa $6  reduced
    { menu_item: '310010', quantity: 1, auto_send: true },   // Monte Xanic  $9  standard
  ]);
  let w = await omni.waitTotals(tid, prev); prev = w.totals.total;
  const r1 = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: 4 });
  if (!r1.got) { console.log('✗ no llegó a MCM'); process.exit(1); }
  const mcmId = r1.got.id;
  console.log(`MCM orden ${mcmId}`);
  await db.syncUntil(S, 'clover', 'push_orders',
    async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 3 });
  await cuadre('A1 · comida $6 + alcohol $9', tid, mcmId, w.totals);

  await omni.addItems(tid, [{ menu_item: '300110', quantity: 1, auto_send: true }]);      // Refritos $6
  w = await omni.waitTotals(tid, prev); prev = w.totals.total;
  await cuadre('A2 · +1 comida $6', tid, mcmId, w.totals);

  await omni.addItems(tid, [{ menu_item: '300025', quantity: 2, auto_send: true }]);      // Elote $13 ×2
  w = await omni.waitTotals(tid, prev); prev = w.totals.total;
  await cuadre('A4 · +1 ítem con quantity=2', tid, mcmId, w.totals);

  const tk = await omni.ticket(tid);
  const victima = els(tk.body._embedded?.items).find((i) => String(i.name).includes('Refritos'));
  console.log(`\n   [void] anulando "${victima?.name}" id=${victima?.id} price=${victima?.price}`);
  const v = await omni.voidItem(tid, victima.id);
  console.log(`   void → HTTP ${v.status} ${v.ok ? 'ok' : JSON.stringify(v.body?.errors)}`);
  w = await omni.waitTotals(tid, prev); prev = w.totals.total;
  await cuadre('A5 · void de ítem fireado', tid, mcmId, w.totals);

  await omni.addItems(tid, [{ menu_item: '300155', quantity: 1, price_level: 'b0', auto_send: true }]); // Arroz $5
  w = await omni.waitTotals(tid, prev); prev = w.totals.total;
  await cuadre('A6 · +1 comida $5 tras el void', tid, mcmId, w.totals);

  const d = await omni.ticketDiscount(tid, 'c36', 200);
  console.log(`\n   [descuento] c36 $2.00 → HTTP ${d.status} ${d.ok ? 'ok' : JSON.stringify(d.body?.errors)}`);
  w = await omni.waitTotals(tid, prev);
  await cuadre('A7 · descuento de ticket $2.00', tid, mcmId, w.totals);

  saveEvidence(`f9-${TOK}`, { ticket: tid, mcm: mcmId, pasos });
  console.log('\n══ RESUMEN F9 ══');
  pasos.forEach((p) => console.log(
    `  ${p.cuadra ? '✓' : '✗'} ${p.paso.padEnd(34)} POS=${String(p.omni.total).padStart(5)} MCM=${String(L.cents(p.mcm_total)).padStart(5)} Clover=${String(p.clover_total).padStart(5)}`));
  const n = await L.assertNeighborsIntact('F9');
  console.log(`  vecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  console.log(`  ticket: ${tid}   MCM: ${mcmId}`);
  await db.close();
})();
