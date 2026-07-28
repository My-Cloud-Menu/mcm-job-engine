/**
 * Verificación final consolidada sobre TODA la certificación.
 * Re-mide cada hallazgo cuantitativo contra el estado actual de los tres sistemas.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const usd = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

(async () => {
  const ev = {};
  const ords = await db.q(S, `select id, pos_id, clover_ticket_id, total, paid, status, payment_status, tax_lines
    from orders where site_id=$1 and pos_id is not null order by id`);
  console.log(`órdenes de la certificación: ${ords.length}\n`);

  let fantasmas = 0, montoFantasma = 0, sinTotalClover = 0, descuadres = 0, sobrecobro = 0;
  let taxDiv = 0, taxDelta = 0, sumTaxPos = 0, sumTaxMcm = 0, leidas = 0;
  const detalle = [];

  for (const o of ords) {
    const tk = await omni.call('GET', `/tickets/${o.pos_id}/?fields=totals(due,paid,total,tax,tips),open`);
    if (!tk.ok) continue;
    const t = tk.body?.totals || {}; leidas++;
    const posTotal = Number(t.total || 0), posTax = Number(t.tax || 0);
    const mcmTotal = Math.round(Number(o.total) * 100);
    const mcmTax = (Array.isArray(o.tax_lines) ? o.tax_lines : []).reduce((a, x) => a + Math.round(Number(x.tax_total ?? 0) * 100), 0);
    sumTaxPos += posTax; sumTaxMcm += mcmTax;
    if (posTax !== mcmTax) { taxDiv++; taxDelta += (mcmTax - posTax); }

    let cl = null;
    if (o.clover_ticket_id) { cl = (await clover.order(o.clover_ticket_id)).body; }
    if (cl) {
      if (cl.total == null) sinTotalClover++;
      else {
        if (Number(cl.total) !== posTotal) { descuadres++; if (Number(cl.total) > posTotal) sobrecobro += Number(cl.total) - posTotal; }
        if (cl.paymentState === 'OPEN' && Number(t.due) === 0) { fantasmas++; montoFantasma += Number(cl.total); }
      }
    }
    detalle.push({ id: o.id, posTotal, mcmTotal, cloverTotal: cl?.total ?? null, posTax, mcmTax, due: t.due, paymentState: cl?.paymentState });
    await sleep(60);
  }

  console.log('══════ VERIFICACIÓN FINAL ══════\n');
  console.log(`Órdenes leídas en los 3 sistemas: ${leidas}/${ords.length}\n`);

  console.log('── Cuadre de dinero');
  console.log(`   descuadres POS ≠ Clover:        ${descuadres}`);
  console.log(`   sobrecobro acumulado de Clover: ${usd(sobrecobro)}`);
  console.log(`   órdenes MCM sin orden Clover:   ${ords.filter((o) => !o.clover_ticket_id).length}`);

  console.log('\n── M7 · órdenes fantasma en Clover');
  console.log(`   Clover OPEN con el cheque de Aloha saldado: ${fantasmas}  →  ${usd(montoFantasma)} en el Register`);
  console.log(`   órdenes Clover con líneas pero SIN total:   ${sinTotalClover}`);

  console.log('\n── F11.5 · base imponible');
  console.log(`   órdenes con impuesto divergente: ${taxDiv}/${leidas}`);
  console.log(`   Σ impuesto POS ${usd(sumTaxPos)} · Σ impuesto MCM ${usd(sumTaxMcm)} · Δ ${usd(taxDelta)} (${(taxDelta / (sumTaxPos || 1) * 100).toFixed(1)}%)`);

  console.log('\n── N3 · fidelidad de tender y propina');
  const met = await db.q(S, `select method, count(*)::int n, sum(total::numeric) monto, sum(tip::numeric) prop
     from payments where site_id=$1 group by 1 order by 2 desc`);
  met.forEach((m) => console.log(`   method='${m.method}': ${m.n} pagos · $${Number(m.monto).toFixed(2)} · propina $${Number(m.prop).toFixed(2)}`));
  console.log(`   métodos distintos: ${met.length}  ${met.length === 1 ? '✗ el cuadre por tender es imposible' : ''}`);

  console.log('\n── Dinero cobrado que NO llegó al POS');
  const nolleg = detalle.filter((d) => Number(d.due) > 0 && ords.find((o) => o.id === d.id && Number(o.paid) > 0));
  console.log(`   órdenes con pago en MCM y due>0 en Aloha: ${nolleg.length}`);

  console.log('\n── Idempotencia');
  const dup = await db.q(S, `select count(*)::int n from (select pos_id from orders where site_id=$1 and pos_id is not null group by pos_id having count(*)>1) x`);
  const dupp = await db.q(S, `select count(*)::int n from (select reference from payments where site_id=$1 and reference is not null group by reference having count(*)>1) x`);
  console.log(`   órdenes duplicadas: ${dup[0].n}  ·  pagos duplicados: ${dupp[0].n}`);

  console.log('\n── Jobs');
  const dl = await db.q(S, `select job_type, count(*)::int n from integration_jobs where site_id=$1 and status='dead_letter' group by 1`);
  dl.forEach((x) => console.log(`   dead_letter ${x.job_type}: ${x.n}`));
  const tot = await db.q(S, `select count(*)::int n from integration_jobs where site_id=$1`);
  console.log(`   jobs totales del site: ${tot[0].n}`);

  saveEvidence(`final-${TOK}`, { detalle, resumen: { leidas, descuadres, sobrecobro, fantasmas, montoFantasma, taxDiv, taxDelta, sumTaxPos, sumTaxMcm } });
  const nb = await L.assertNeighborsIntact('final');
  console.log(`\n   vecinos: ${nb.ok ? 'sin cambios inesperados' : 'REVISAR'}`);
  await db.close();
})();
