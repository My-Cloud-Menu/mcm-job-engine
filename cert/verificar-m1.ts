/**
 * Verifica el arreglo de M1 de punta a punta, con propina real.
 *
 *   ticket en Aloha → MCM → Clover → cobro CON propina → MCM → cheque cerrado en Aloha
 *
 * El caso que fallaba: la propina se restaba dos veces y el cheque quedaba con saldo
 * pendiente justo por su valor (orden 10334: se envió 3189 en vez de 5189, faltaron $20).
 *
 * Acotado a site_id=99990003. Solo lectura salvo el ticket y el cobro de prueba.
 */
import 'dotenv/config';
import { Client } from 'pg';

const S = 99990003;
const PROPINA = 500; // $5.00
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const els = (x: any) => (Array.isArray(x) ? x : x?.elements || []);

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const q = async (sql: string, p: any[] = []) => (await c.query(sql, p)).rows;
  const cfgO = (await q("select config from site_integrations where site_id=$1 and provider='omnivore' and type='pos'", [S]))[0].config;
  const cfgC = (await q("select config from site_integrations where site_id=$1 and provider='clover'", [S]))[0].config;

  const OB = 'https://api.omnivore.io/1.0/locations/' + cfgO.omnivoreId;
  const OH = { 'Api-Key': cfgO.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  const omni = async (m: string, p: string, b?: any) => {
    const r = await fetch(OB + p, { method: m, headers: OH, body: b ? JSON.stringify(b) : undefined });
    const j: any = await r.json().catch(() => null);
    return { ok: r.status < 300 && !j?.errors, status: r.status, body: j };
  };
  const omniR = async (m: string, p: string, b?: any, n = 6) => {
    let r: any = null;
    for (let k = 1; k <= n; k++) {
      r = await omni(m, p, b);
      const e = r.body?.errors?.[0]?.error;
      const transitorio = ['timeout', 'pos_not_responding_retry', 'pos_offline', 'agent_offline'].includes(e) || r.status >= 500;
      if (r.ok || !transitorio) return r;
      await sleep(2500 * k);
    }
    return r;
  };
  const CB = `${cfgC.apiUrl}/v3/merchants/${cfgC.merchantId}`;
  const CH = { Authorization: 'Bearer ' + cfgC.apiKey, 'Content-Type': 'application/json', 'User-Agent': 'MCM-Cert/1.0' };
  const clover = async (m: string, p: string, b?: any) => {
    const r = await fetch(CB + p, { method: m, headers: CH, body: b ? JSON.stringify(b) : undefined });
    const j: any = await r.json().catch(() => null);
    return { ok: r.status < 300, status: r.status, body: j };
  };
  const esperar = async (etiqueta: string, check: () => Promise<any>, maxMs = 240000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const v = await check();
      if (v) { console.log(`   ✓ ${etiqueta} (${Math.round((Date.now() - t0) / 1000)}s)`); return v; }
      await sleep(5000);
    }
    console.log(`   ✗ ${etiqueta}: no ocurrió`);
    return null;
  };

  console.log('═══ Verificación de M1 · cobro CON propina ═══\n');

  const tb = await omniR('GET', '/tables/?limit=1000');
  if (!tb.ok) { console.log('✗ el POS no responde'); await c.end(); return; }
  const libres = els(tb.body?._embedded?.tables).filter((x: any) => x.available).map((x: any) => String(x.id));

  let t: any = null;
  for (const mesa of libres.slice(0, 10)) {
    t = await omniR('POST', '/tickets/', {
      employee: cfgO.defaultEmployeeId || '975', order_type: cfgO.defaultOrderTypeId || '1',
      revenue_center: cfgO.defaultRevenueCenterId || '20', table: mesa,
      guest_count: 1, name: 'VERIF-M1', auto_send: false,
    });
    if (t.ok) break;
  }
  if (!t?.ok) { console.log('✗ no se pudo abrir ticket: ' + JSON.stringify(t?.body?.errors)); await c.end(); return; }
  const tid = t.body.id;
  await omniR('POST', `/tickets/${tid}/items/`, { items: [{ menu_item: '300025', quantity: 1, auto_send: true }] });
  let tot: any = null;
  for (let k = 0; k < 15; k++) {
    await sleep(2000);
    const g = await omniR('GET', `/tickets/${tid}/?fields=totals(total,due)`);
    if (Number(g.body?.totals?.total) > 0) { tot = g.body.totals; break; }
  }
  if (!tot) { console.log('✗ el POS no totalizó'); await c.end(); return; }
  console.log(`1 · ticket ${tid} · cheque ${tot.total}¢`);

  const o = await esperar('llegó a MCM', async () => (await q('select * from orders where site_id=$1 and pos_id=$2', [S, tid]))[0]);
  if (!o) { await c.end(); return; }
  const oc = await esperar('empujado a Clover', async () => {
    const x = (await q('select * from orders where site_id=$1 and id=$2', [S, o.id]))[0];
    return x?.clover_ticket_id ? x : null;
  });
  if (!oc) { await c.end(); return; }

  console.log(`\n2 · cobrando en Clover: amount ${tot.total}¢ + propina ${PROPINA}¢ = ${Number(tot.total) + PROPINA}¢ al cliente`);
  const pay = await clover('POST', `/orders/${oc.clover_ticket_id}/payments`, {
    amount: Number(tot.total), tipAmount: PROPINA,
    tender: { id: cfgC.defaultTenderId }, externalPaymentId: 'm1v' + (Date.now() % 1e8),
  });
  console.log(`   → HTTP ${pay.status} ${pay.ok ? 'pago ' + pay.body?.id : JSON.stringify(pay.body).slice(0, 140)}`);
  if (!pay.ok) { await c.end(); return; }

  console.log(`\n3 · esperando el pago en MCM`);
  const pm = await esperar('pago registrado', async () => {
    const r = await q('select id,total,tip from payments where site_id=$1 and $2=any(orders_ids)', [S, o.id]);
    return r.length ? r : null;
  });
  if (pm) {
    const p = pm[0];
    const esperado = ((Number(tot.total) + PROPINA) / 100).toFixed(2);
    console.log(`   payments.total = ${p.total} · tip = ${p.tip}`);
    console.log(`   ${Number(p.total).toFixed(2) === esperado ? '✓' : '✗'} debe ser ${esperado} (cheque + propina)`);
  }

  console.log(`\n4 · esperando el reenvío al POS`);
  const jb = await esperar('job de reenvío creado', async () => {
    const r = await q(`select id,status,payload->'payment' p from integration_jobs
      where site_id=$1 and job_type='payment_injection' and payload->>'order_id'=$2`, [S, String(o.id)]);
    return r.length ? r : null;
  }, 120000);
  if (jb) jb.forEach((x: any) => console.log(`   ${x.status} · enviado: ${JSON.stringify(x.p)}`));

  const cerrado = await esperar('cheque cerrado en Aloha', async () => {
    const g = await omniR('GET', `/tickets/${tid}/?fields=totals(due,paid,total,tips),open`);
    return Number(g.body?.totals?.due) === 0 && Number(g.body?.totals?.paid) > 0 ? g.body : null;
  });

  console.log('\n══ VEREDICTO ══');
  if (cerrado) {
    console.log(`   Aloha: due ${cerrado.totals.due} · paid ${cerrado.totals.paid} · tips ${cerrado.totals.tips} · open ${cerrado.open}`);
    console.log(`   ${Number(cerrado.totals.due) === 0 ? '✓ el cheque cerró COMPLETO — M1 arreglado' : '✗ quedó saldo pendiente'}`);
    console.log(`   ${Number(cerrado.totals.tips) === PROPINA ? '✓ la propina quedó registrada en el POS' : '~ propina en el POS: ' + cerrado.totals.tips}`);
  } else {
    const g = await omniR('GET', `/tickets/${tid}/?fields=totals(due,paid,tips),open`);
    console.log(`   Aloha: ${JSON.stringify(g.body?.totals)} · open ${g.body?.open}`);
  }
  console.log(`\n   ticket ${tid} · orden MCM ${o.id} · orden Clover ${oc.clover_ticket_id}`);
  await c.end();
})();
