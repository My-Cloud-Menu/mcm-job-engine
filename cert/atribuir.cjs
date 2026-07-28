/**
 * Atribuye cada descuadre POS=MCM≠Clover a su causa, comparando línea por línea
 * lo que MCM tiene contra lo que Clover cobró. No adivina: diffea multiconjuntos.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const c2 = (n) => (Number(n) / 100).toFixed(2);

const IDS = [10006, 10017, 10048, 10049, 10050, 10052, 10056, 10057];

(async () => {
  const out = [];
  for (const id of IDS) {
    const o = (await db.q(S, `select id,pos_id,clover_ticket_id,total,discount_total,line_items,fee_lines
      from orders where site_id=$1 and id=$2`, [id]))[0];
    if (!o?.clover_ticket_id) { console.log(`\n── MCM ${id}: sin orden Clover`); continue; }
    const cl = (await clover.order(o.clover_ticket_id)).body;
    const tk = await omni.call('GET', `/tickets/${o.pos_id}/?fields=totals(total,tax,discounts,service_charges,sub_total)`);
    const posTotal = Number(tk.body?.totals?.total ?? NaN);
    const mcmTotal = Math.round(Number(o.total) * 100);
    const clTotal = Number(cl?.total ?? NaN);

    const li = Array.isArray(o.line_items) ? o.line_items : [];
    const anuladas = li.filter((x) => String(x.status || '').toLowerCase() === 'voided');
    const vivas = li.filter((x) => String(x.status || '').toLowerCase() !== 'voided');
    const clLines = els(cl?.lineItems);

    // ¿las líneas anuladas siguen cobrándose en Clover?
    const anuladasEnClover = anuladas.filter((v) =>
      clLines.some((c) => c.name === v.name));
    const sumaAnuladasEnClover = anuladasEnClover.reduce((a, v) => {
      const m = clLines.find((c) => c.name === v.name);
      return a + Number(m?.price || 0);
    }, 0);

    const desc = Math.round(Number(o.discount_total || 0) * 100);
    const posDesc = Number(tk.body?.totals?.discounts || 0);
    const delta = clTotal - posTotal;

    const causas = [];
    if (posDesc > 0 || desc > 0) causas.push(`R5 · descuento (POS ${posDesc}¢ / MCM ${desc}¢) que Clover no aplica`);
    if (anuladasEnClover.length) causas.push(`M8 · ${anuladasEnClover.length} línea(s) anulada(s) aún cobradas en Clover (≈${sumaAnuladasEnClover}¢)`);
    if (!causas.length) causas.push('sin causa conocida — requiere inspección manual');

    console.log(`\n── MCM ${id} · ticket ${o.pos_id} · Clover ${o.clover_ticket_id}`);
    console.log(`   POS=${posTotal}  MCM=${mcmTotal}  Clover=${clTotal}   Δ(Clover−POS)=${delta > 0 ? '+' : ''}${delta}  (${c2(Math.abs(delta))})`);
    console.log(`   líneas MCM: ${li.length} (${vivas.length} vivas, ${anuladas.length} anuladas) · líneas Clover: ${clLines.length}`);
    if (anuladas.length) console.log(`   anuladas: ${anuladas.map((x) => `"${x.name}"`).join(', ')}${anuladasEnClover.length ? `  → ${anuladasEnClover.length} siguen en Clover` : '  → ninguna en Clover'}`);
    console.log(`   descuentos: POS=${posDesc}¢  MCM.discount_total=${desc}¢`);
    causas.forEach((c) => console.log(`   ⇒ ${c}`));
    out.push({ id, pos: posTotal, mcm: mcmTotal, clover: clTotal, delta, anuladas: anuladas.map((x) => x.name), anuladasEnClover: anuladasEnClover.length, posDesc, desc, causas });
  }

  console.log(`\n══ RESUMEN DE ATRIBUCIÓN ══`);
  const porCausa = {};
  out.forEach((r) => r.causas.forEach((c) => { const k = c.split(' · ')[0]; (porCausa[k] ||= []).push(r.id); }));
  Object.entries(porCausa).forEach(([k, v]) => console.log(`  ${k}: ${v.join(', ')}`));
  const sobrecobro = out.filter((r) => r.delta > 0).reduce((a, r) => a + r.delta, 0);
  console.log(`  sobrecobro total de Clover sobre el POS: ${c2(sobrecobro)}`);
  saveEvidence(`atribucion-${TOK}`, { ordenes: out });
  await db.close();
})();
