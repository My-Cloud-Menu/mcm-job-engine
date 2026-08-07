/**
 * Verificación del loop completo sobre el site de certificación (99990003).
 * Lee las credenciales de la base — no depende de ningún archivo de entorno.
 *
 *   Aloha (ticket) → MCM → Clover (orden) → cobro en Clover → MCM → Aloha (cheque cerrado)
 *
 * Se cobra con propina 0 a propósito: es el único caso que hoy cierra el cheque
 * (ver M1 en HALLAZGOS.md). Todo va contra site_id=99990003 y nada más.
 */
require('dotenv').config();
const { Client } = require('pg');
const S = 99990003;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const q = async (sql, p = []) => (await c.query(sql, p)).rows;
  const cfgO = (await q("select config from site_integrations where site_id=$1 and provider='omnivore' and type='pos'", [S]))[0].config;
  const cfgC = (await q("select config from site_integrations where site_id=$1 and provider='clover'", [S]))[0].config;

  const OB = 'https://api.omnivore.io/1.0/locations/' + cfgO.omnivoreId;
  const OH = { 'Api-Key': cfgO.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  const omni = async (m, p, b) => {
    const r = await fetch(OB + p, { method: m, headers: OH, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j, ok: r.status < 300 && !j?.errors };
  };
  const CB = `${cfgC.apiUrl}/v3/merchants/${cfgC.merchantId}`;
  const CH = { Authorization: 'Bearer ' + cfgC.apiKey, 'Content-Type': 'application/json', 'User-Agent': 'MyCloudMenu-Cert/1.0' };
  const clover = async (m, p, b) => {
    const r = await fetch(CB + p, { method: m, headers: CH, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j, ok: r.status < 300 };
  };
  const orden = async (id) => (await q('select * from orders where site_id=$1 and id=$2', [S, id]))[0];
  const porTicket = async (tid) => (await q('select * from orders where site_id=$1 and pos_id=$2', [S, tid]))[0];
  /** Espera hasta que check() devuelva algo, sin forzar syncs: los schedules ya corren solos. */
  const esperar = async (etiqueta, check, maxMs = 180000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const v = await check();
      if (v) { console.log(`   ✓ ${etiqueta} (${Math.round((Date.now() - t0) / 1000)}s)`); return v; }
      await sleep(5000);
    }
    console.log(`   ✗ ${etiqueta}: no ocurrió en ${maxMs / 1000}s`);
    return null;
  };

  console.log(`═══ Verificación del loop · site ${S} · location ${cfgO.omnivoreId} ═══\n`);

  // ── 1 · ticket en Aloha
  // El agente de Aloha de este sandbox está `degraded` y devuelve timeout de forma
  // intermitente — reintentar con backoff, como haría el terminal real.
  // Mesas libres: la certificación dejó ~200 tickets abiertos ocupando mesas, y si no
  // se pasa una, Aloha auto-asigna y choca con `table_unavailable`.
  /** Reintenta las lecturas: el agente de este sandbox devuelve `timeout` de forma
   *  intermitente, y tratar esa respuesta como dato vacío lleva a conclusiones falsas. */
  const SLUGS_TRANSITORIOS = ['timeout', 'pos_not_responding_retry', 'pos_offline', 'agent_offline'];
  /** Transitorio = slug conocido del agente O cualquier 5xx de transporte (502/503/504
   *  llegan SIN cuerpo de error, así que mirar solo el slug los daba por definitivos). */
  const esTransitorio = (r) => SLUGS_TRANSITORIOS.includes(r.body?.errors?.[0]?.error) || r.status >= 500;
  const omniR = async (m, p, b, n = 6) => {
    let r = null;
    for (let k = 1; k <= n; k++) {
      r = await omni(m, p, b);
      if (r.ok || !esTransitorio(r)) return r;
      await sleep(2500 * k);
    }
    return r;
  };

  const tb = await omniR('GET', '/tables/?limit=1000');
  if (!tb.ok) { console.log('✗ /tables no responde — el agente de Aloha está caído'); await c.end(); return; }
  const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  console.log(`0 · mesas: ${els(tb.body?._embedded?.tables).length} totales · ${libres.length} disponibles`);
  if (!libres.length) { console.log('✗ no hay ninguna mesa libre'); await c.end(); return; }
  let t = null;
  let intentos = 0;
  for (let i = 0; i < libres.length; i++) {
    t = await omniR('POST', '/tickets/', {
      employee: cfgO.defaultEmployeeId || '975',
      order_type: cfgO.defaultOrderTypeId || '1',
      revenue_center: cfgO.defaultRevenueCenterId || '20',
      table: libres[i], guest_count: 1, name: 'VERIF-LOOP', auto_send: false,
    });
    if (t.ok) { console.log(`   mesa ${libres[i]}: ✓ abierta (tras ${intentos} rechazos)`); break; }
    const e = t.body?.errors?.[0]?.error;
    intentos++;
    if (intentos <= 6 || intentos % 15 === 0) console.log(`   mesa ${libres[i]}: ${e || t.status}`);
    if (['timeout', 'pos_not_responding_retry', 'pos_offline', 'agent_offline'].includes(e)) await sleep(2500);
    else if (e !== 'table_unavailable') { console.log(`   error no recuperable: ${JSON.stringify(t.body?.errors)}`); break; }
  }
  if (!t?.ok) { console.log('✗ no se pudo abrir el ticket: ' + JSON.stringify(t?.body?.errors)); await c.end(); return; }
  const tid = t.body.id;
  console.log(`1 · ticket abierto en Aloha: ${tid}`);
  const ai = await omniR('POST', `/tickets/${tid}/items/`, { items: [{ menu_item: '300015', quantity: 1, auto_send: true }] });
  if (!ai.ok) { console.log('   ✗ addItems: ' + JSON.stringify(ai.body?.errors)); await c.end(); return; }
  let tot = null;
  for (let k = 0; k < 15; k++) {
    await sleep(2000);
    const g = await omniR('GET', `/tickets/${tid}/?fields=totals(total,due)`);
    if (Number(g.body?.totals?.total) > 0) { tot = g.body.totals; break; }
  }
  if (!tot) { console.log('   ✗ el POS no totalizó'); await c.end(); return; }
  console.log(`   total en el POS: ${tot.total}¢ · due ${tot.due}¢`);

  // ── 2 · ingesta a MCM
  console.log(`\n2 · esperando la ingesta a MCM (fetch_open_orders, cada 20s)`);
  const o = await esperar('llegó a MCM', () => porTicket(tid));
  if (!o) { await c.end(); return; }
  const li = Array.isArray(o.line_items) ? o.line_items : [];
  console.log(`   orden MCM ${o.id} · total ${o.total} · status ${o.status} · ${li.length} línea(s) · unmapped: ${li.filter((x) => x.unmapped).length}`);
  const cuadraMcm = Math.round(Number(o.total) * 100) === Number(tot.total);
  console.log(`   ${cuadraMcm ? '✓' : '✗'} POS ${tot.total}¢ vs MCM ${Math.round(Number(o.total) * 100)}¢`);

  // ── 3 · push a Clover
  console.log(`\n3 · esperando el push a Clover (push_orders, cada 15s)`);
  const oc = await esperar('orden creada en Clover', async () => {
    const x = await orden(o.id); return x?.clover_ticket_id ? x : null;
  });
  if (!oc) { await c.end(); return; }
  const cl = await clover('GET', `/orders/${oc.clover_ticket_id}?expand=lineItems`);
  console.log(`   orden Clover ${oc.clover_ticket_id} · total ${cl.body?.total}¢ · ${els(cl.body?.lineItems).length} línea(s) · state ${cl.body?.state}`);
  const cuadraClover = Number(cl.body?.total) === Number(tot.total);
  console.log(`   ${cuadraClover ? '✓' : '✗'} POS ${tot.total}¢ vs Clover ${cl.body?.total}¢`);

  // ── 4 · cobro en Clover (propina 0 — el caso que sí cierra el cheque)
  console.log(`\n4 · cobrando en Clover ${tot.total}¢ con propina 0`);
  const pay = await clover('POST', `/orders/${oc.clover_ticket_id}/payments`, {
    amount: Number(tot.total), tipAmount: 0,
    tender: { id: cfgC.defaultTenderId },
    externalPaymentId: 'verif' + (Date.now() % 1e8),
  });
  console.log(`   → HTTP ${pay.status}${pay.ok ? ' · pago ' + pay.body?.id : ' ' + JSON.stringify(pay.body).slice(0, 160)}`);
  if (!pay.ok) { await c.end(); return; }

  // ── 5 · el pago vuelve a MCM
  console.log(`\n5 · esperando que el pago llegue a MCM (fetch_payments, cada 15s)`);
  const pm = await esperar('pago registrado en MCM', async () => {
    const r = await q('select id,total,tip,method,source,pos_id from payments where site_id=$1 and $2=any(orders_ids)', [S, o.id]);
    return r.length ? r : null;
  });
  if (pm) pm.forEach((p) => console.log(`   pago MCM ${p.id}: ${p.method} $${p.total} tip $${p.tip} · pos_id ${p.pos_id}`));
  const o2 = await orden(o.id);
  console.log(`   orden MCM: paid ${o2.paid} · payment_status ${o2.payment_status} · status ${o2.status}`);

  // ── 6 · el pago se reenvía al POS y cierra el cheque
  console.log(`\n6 · esperando el reenvío a Aloha y el cierre del cheque`);
  const cerrado = await esperar('cheque cerrado en Aloha', async () => {
    const g = await omniR('GET', `/tickets/${tid}/?fields=totals(due,paid,tips),open`);
    return Number(g.body?.totals?.due) === 0 && Number(g.body?.totals?.paid) > 0 ? g.body : null;
  });
  if (cerrado) console.log(`   Aloha: due ${cerrado.totals.due} · paid ${cerrado.totals.paid} · tips ${cerrado.totals.tips} · open ${cerrado.open}`);
  const jb = await q(`select j.status, j.payload->'payment' p, a.error_code
     from integration_jobs j left join job_steps s on s.job_id=j.id left join job_step_attempts a on a.step_id=s.id
     where j.site_id=$1 and j.job_type='payment_injection' and j.payload->>'order_id'=$2`, [S, String(o.id)]);
  jb.forEach((x) => console.log(`   reenvío: ${x.status}${x.error_code ? ' · ' + x.error_code : ''} · enviado ${JSON.stringify(x.p)}`));

  // ── veredicto
  console.log(`\n══ VEREDICTO ══`);
  console.log(`   Omnivore → MCM      ${cuadraMcm ? '✓ cuadra' : '✗'}`);
  console.log(`   MCM → Clover        ${cuadraClover ? '✓ cuadra' : '✗'}`);
  console.log(`   cobro en Clover     ${pay.ok ? '✓' : '✗'}`);
  console.log(`   Clover → MCM        ${pm ? '✓ pago registrado' : '✗'}`);
  console.log(`   MCM → Aloha         ${cerrado ? '✓ cheque cerrado' : '✗ el cheque sigue abierto'}`);
  console.log(`\n   ticket: ${tid} · orden MCM: ${o.id} · orden Clover: ${oc.clover_ticket_id}`);
  await c.end();
})();
