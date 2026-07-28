/**
 * F11 · Reconciliación de cierre sobre TODA la corrida de certificación.
 *
 *  11.1 cuadre triple    Σ Omnivore == Σ MCM == Σ Clover, al centavo, orden por orden
 *  11.5 base imponible   Σ tax_lines de MCM contra totals.tax del POS (exposición de planilla IVU)
 *  11.6 tickets          cheques abiertos en Aloha que MCM da por cerrados, y al revés
 *  11.8 huérfanos        órdenes Clover sin contraparte, pagos sin orden, órdenes MCM sin ticket
 *
 * Todo scoped a site 99990003. Lee de las tres fuentes; no reconstruye ningún número.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const c2 = (n) => (n / 100).toFixed(2);

(async () => {
  const rows = await db.q(S, `
    select id, pos_id, clover_ticket_id, status, payment_status, total, paid,
           tax_lines, additional_properties
    from orders where site_id=$1 and pos_id is not null order by id`);
  console.log(`órdenes de la certificación: ${rows.length}\n`);

  const res = [];
  for (const o of rows) {
    const r = { mcm_id: o.id, ticket: o.pos_id, clover_id: o.clover_ticket_id };
    const tk = await omni.call('GET', `/tickets/${o.pos_id}/?fields=totals(due,paid,total,tax,tips),open`);
    if (!tk.ok) { r.omni_error = tk.body?.errors?.[0]?.error || tk.status; res.push(r); continue; }
    const t = tk.body?.totals || {};
    r.omni = { total: t.total, tax: t.tax, due: t.due, paid: t.paid, tips: t.tips, open: tk.body?.open };
    r.mcm = { total: Math.round(Number(o.total) * 100), paid: Math.round(Number(o.paid || 0) * 100), status: o.status, payment_status: o.payment_status };

    // Σ tax_lines de MCM (F11.5)
    const tl = Array.isArray(o.tax_lines) ? o.tax_lines : [];
    r.mcm.tax = tl.reduce((a, x) => a + Math.round(Number(x.tax_total ?? 0) * 100), 0);

    if (o.clover_ticket_id) {
      const cl = await clover.order(o.clover_ticket_id);
      if (cl.body?.id) {
        // `total` ausente ⇒ el POST /orders/{id} {total} posterior al bulk no llegó a persistir:
        // el Register muestra $0.00 aunque la orden tenga líneas (F2.5).
        r.clover = { total: cl.body.total, sin_total: cl.body.total == null, paymentState: cl.body.paymentState, state: cl.body.state };
        r.clover.lineas = els(cl.body.lineItems).length;
        r.clover.suma_lineas = els(cl.body.lineItems).reduce((a, li) => a + Number(li.price || 0), 0);
        r.clover.pagos = els(cl.body.payments).reduce((a, p) => a + Number(p.amount || 0), 0);
        r.clover.propinas = els(cl.body.payments).reduce((a, p) => a + Number(p.tipAmount || 0), 0);
      } else r.clover_error = cl.status;
    }

    r.cuadra_total = r.clover ? (r.omni.total === r.mcm.total && r.mcm.total === r.clover.total) : (r.omni.total === r.mcm.total);
    r.cuadra_tax = r.omni.tax === r.mcm.tax;
    r.delta_tax = r.mcm.tax - r.omni.tax;
    res.push(r);
    await sleep(120);
  }

  const val = res.filter((r) => r.omni);
  const conClover = val.filter((r) => r.clover);

  console.log('── 11.1 · cuadre triple (al centavo)');
  const desc = val.filter((r) => !r.cuadra_total);
  console.log(`   órdenes leídas en los 3 sistemas: ${conClover.length} · solo POS+MCM: ${val.length - conClover.length}`);
  console.log(`   cuadran: ${val.length - desc.length}/${val.length}`);
  desc.forEach((r) => console.log(`   ✗ MCM ${r.mcm_id}: POS=${r.omni.total} MCM=${r.mcm.total} Clover=${r.clover?.total ?? '—'}`));

  console.log('\n── 11.5 · base imponible: Σ tax_lines de MCM vs totals.tax del POS');
  const tdesc = val.filter((r) => !r.cuadra_tax);
  console.log(`   cuadran: ${val.length - tdesc.length}/${val.length}`);
  tdesc.slice(0, 12).forEach((r) => console.log(`   ✗ MCM ${r.mcm_id}: POS tax=${r.omni.tax} MCM Σtax_lines=${r.mcm.tax}  Δ=${r.delta_tax > 0 ? '+' : ''}${r.delta_tax}`));
  const sumOmniTax = val.reduce((a, r) => a + Number(r.omni.tax || 0), 0);
  const sumMcmTax = val.reduce((a, r) => a + r.mcm.tax, 0);
  console.log(`   Σ impuesto POS = ${c2(sumOmniTax)}   Σ impuesto MCM = ${c2(sumMcmTax)}   Δ = ${c2(sumMcmTax - sumOmniTax)}`);

  console.log('\n── 11.6 · estado de los cheques');
  const abiertoEnPos = val.filter((r) => r.omni.open === true && ['check-closed'].includes(r.mcm.status));
  const cerradoEnPos = val.filter((r) => r.omni.open === false && r.mcm.status !== 'check-closed');
  const cobradoSinCerrar = val.filter((r) => Number(r.omni.due) > 0 && Number(r.mcm.paid) > 0);
  console.log(`   abiertos en Aloha que MCM da por cerrados: ${abiertoEnPos.length}${abiertoEnPos.length ? ' → ' + abiertoEnPos.map((r) => r.mcm_id).join(', ') : ''}`);
  console.log(`   cerrados en Aloha que MCM NO da por cerrados: ${cerradoEnPos.length}${cerradoEnPos.length ? ' → ' + cerradoEnPos.map((r) => r.mcm_id).join(', ') : ''}`);
  console.log(`   cobrados en MCM con due>0 en Aloha (dinero no aplicado al POS): ${cobradoSinCerrar.length}${cobradoSinCerrar.length ? ' → ' + cobradoSinCerrar.map((r) => `${r.mcm_id}(due ${r.omni.due})`).join(', ') : ''}`);

  console.log('\n── 11.8 · huérfanos y órdenes fantasma en Clover');
  const fantasma = conClover.filter((r) => r.clover.paymentState === 'OPEN' && Number(r.omni.due) === 0);
  const sumFantasma = fantasma.reduce((a, r) => a + Number(r.clover.total || 0), 0);
  console.log(`   órdenes Clover ABIERTAS cuyo cheque ya está cobrado en Aloha: ${fantasma.length}  (${c2(sumFantasma)} en el Register)`);
  fantasma.forEach((r) => console.log(`      ${r.clover_id}  ${c2(r.clover.total)}  ← MCM ${r.mcm_id} / ticket ${r.ticket}`));
  const sinClover = val.filter((r) => !r.clover_id);
  console.log(`   órdenes MCM sin orden en Clover: ${sinClover.length}${sinClover.length ? ' → ' + sinClover.map((r) => r.mcm_id).join(', ') : ''}`);
  const sinTotal = conClover.filter((r) => r.clover.sin_total);
  console.log(`   órdenes Clover CON líneas pero SIN total (Register muestra $0.00): ${sinTotal.length}`);
  sinTotal.forEach((r) => console.log(`      ${r.clover_id}  ${r.clover.lineas} líneas Σ${c2(r.clover.suma_lineas)}  ← MCM ${r.mcm_id} (MCM total ${c2(r.mcm.total)})`));

  const pagosHuerf = await db.q(S, `select id,total,orders_ids from payments where site_id=$1
     and (orders_ids is null or array_length(orders_ids,1) is null)`);
  console.log(`   pagos sin orden asociada: ${pagosHuerf.length}`);

  console.log('\n── 11.4 · propinas');
  const propClover = conClover.reduce((a, r) => a + Number(r.clover.propinas || 0), 0);
  const propAloha = val.reduce((a, r) => a + Number(r.omni.tips || 0), 0);
  const propMcm = (await db.q(S, `select coalesce(sum(tip::numeric),0) as t from payments where site_id=$1`))[0].t;
  console.log(`   propina cobrada en Clover: ${c2(propClover)}   registrada en Aloha: ${c2(propAloha)}   registrada en MCM: ${Number(propMcm).toFixed(2)}`);

  saveEvidence(`f11-${TOK}`, { ordenes: res });
  const n = await L.assertNeighborsIntact('F11');
  console.log(`\nvecinos intactos: ${n.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
