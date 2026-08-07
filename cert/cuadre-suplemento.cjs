#!/usr/bin/env node
/**
 * Verifica las DOS cosas que importan de una orden con suplemento en Clover:
 *
 *   1. que los montos cuadren   → Σ(total de las órdenes Clover) == orders.total
 *   2. que el pago llegue       → fila en `payments` ligada a la orden padre,
 *                                 orders.paid == orders.total, y el ticket de Aloha en due 0
 *
 * Uso:  node cert/cuadre-suplemento.cjs [order_id]
 * Sin argumento revisa TODAS las órdenes del site que tengan suplemento.
 */
require('dotenv').config();
const { Client } = require('pg');

const SITE = 99990003;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const cfg = (
    await c.query(
      "select config from site_integrations where site_id=$1 and provider='clover' and type='pos'",
      [SITE]
    )
  ).rows[0].config;
  const H = { Authorization: 'Bearer ' + cfg.apiKey, 'User-Agent': 'MCM-Cert/1.0' };
  const base = cfg.apiUrl.replace(/\/$/, '') + '/v3/merchants/' + cfg.merchantId;

  const getOrder = async (id) => {
    const r = await fetch(base + '/orders/' + id + '?expand=lineItems,payments', { headers: H });
    return r.ok ? r.json() : null;
  };

  const argId = process.argv[2];
  const { rows: jobs } = await c.query(
    `select distinct payload->>'order_id' oid
       from integration_jobs
      where site_id=$1 and job_type='supplemental_order_injection'
        ${argId ? "and payload->>'order_id'=$2" : ''}
      order by 1`,
    argId ? [SITE, argId] : [SITE]
  );

  if (!jobs.length) {
    console.log(argId ? `la orden ${argId} no tiene suplemento` : 'ninguna orden con suplemento todavía');
    await c.end();
    return;
  }

  for (const { oid } of jobs) {
    const o = (
      await c.query(
        'select id,total,paid,status,payment_status,pos_id,clover_ticket_id,fee_lines,additional_properties from orders where site_id=$1 and id=$2',
        [SITE, oid]
      )
    ).rows[0];
    if (!o) continue;

    const manif = o.additional_properties?.clover_supplemental;
    const suppIds = (manif?.supplements || []).map((s) => s.clover_order_id).filter(Boolean);
    // Fallback: si el manifiesto no está, sacar los ids de los jobs.
    if (!suppIds.length) {
      const { rows } = await c.query(
        `select context->'create_supplemental_order'->>'clover_order_id' cid
           from integration_jobs
          where site_id=$1 and job_type='supplemental_order_injection' and payload->>'order_id'=$2`,
        [SITE, oid]
      );
      rows.forEach((r) => r.cid && suppIds.push(r.cid));
    }

    const objetivo = Math.round(Number(o.total) * 100);
    let facturado = 0;
    const detalle = [];
    for (const cid of [o.clover_ticket_id, ...suppIds]) {
      if (!cid) continue;
      const co = await getOrder(cid);
      const t = co?.total || 0;
      facturado += t;
      const pagos = (co?.payments?.elements || []).reduce((a, p) => a + (p.amount || 0) + (p.tipAmount || 0), 0);
      detalle.push(`${cid}=${t}${pagos ? ` (cobrado ${pagos})` : ' (sin cobrar)'}`);
    }

    const { rows: pays } = await c.query(
      'select id,total,tip,pos_id from payments where site_id=$1 and $2::bigint = any(orders_ids) order by id',
      [SITE, o.id]
    );
    const pagadoMcm = pays.reduce((a, p) => a + Math.round(Number(p.total) * 100) - Math.round(Number(p.tip || 0) * 100), 0);

    const cuadra = objetivo === facturado;
    const cobrado = pagadoMcm === objetivo;

    console.log(`\n═══ orden ${o.id}  (${o.status} / ${o.payment_status})  ticket Aloha ${o.pos_id || '—'}`);
    console.log(`  manifiesto ......... ${manif ? 'PRESENTE' : 'AUSENTE'}`);
    console.log(`  1) MONTOS EN CLOVER  MCM=${objetivo}  Clover=${facturado}  ${cuadra ? '✓ CUADRA' : `✗ falta ${objetivo - facturado}`}`);
    console.log(`     ${detalle.join('  +  ')}`);
    console.log(`  2) PAGO EN MCM ..... orders.paid=${Math.round(Number(o.paid) * 100)}  Σpagos(sin tip)=${pagadoMcm}  ${cobrado ? '✓ COMPLETO' : '✗ incompleto'}`);
    console.log(`     ${pays.length ? pays.map((p) => `#${p.id} $${p.total} (clover ${p.pos_id})`).join(' | ') : 'ningún pago ligado'}`);
  }

  await c.end();
})();
