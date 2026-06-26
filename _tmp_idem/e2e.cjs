/**
 * E2E exhaustivo del hardening de idempotencia contra los EDGES DESPLEGADOS en DEV
 * + Aloha real + DB. Auth: token service_role (los guards lo dejan pasar, RLS bypass).
 * Limpia todo lo que crea al final.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');

const SITE = 55126712;
const TOK = Date.now().toString(36).slice(-5).toUpperCase();
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPA = process.env.SUPABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [], fail = [];
const ok = (n, d) => { pass.push(n); console.log(`✅ ${n} — ${d}`); };
const no = (n, d) => { fail.push(n); console.log(`❌ ${n} — ${d}`); };

// tablas disponibles distintas por test (evitar table-lock entre tests)
const T = {
  openA: 'cd69ae1c-b8cf-4b66-ab6d-8ee5820135b2', // 100
  fire:  '608e1e39-7e4d-4b25-bcaf-9fc853243ab4', // 101
  recon: '2df8025e-d27e-4c6c-8ed4-a5e1e744d014', // 102
  void:  '614c3e24-b760-4d52-b0d5-1322dcc5840a', // 103
  conc:  '124c58c0-78dd-4aad-95cb-a5b94dfadfd5', // 10
  stale: 'cd69ae1c-b8cf-4b66-ab6d-8ee5820135b2', // reusa 100 (secuencial, ok)
};
const PROD = 10002; // Chips & Salsa → omnivoreId 300015

const edge = async (slug, body, idempotency_key) => {
  const r = await axios.post(`${SUPA}/functions/v1/${slug}`,
    { site_id: SITE, ...body, ...(idempotency_key ? { idempotency_key } : {}) },
    { headers: { Authorization: `Bearer ${SR}`, apikey: SR, 'Content-Type': 'application/json' }, validateStatus: () => true });
  return r;
};

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE]);
  const cfg = rows[0].config;
  const ax = axios.create({ baseURL: `https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`, headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
  const createdOrders = new Set(), createdTickets = new Set(), usedTables = new Set(), idemKeys = [];
  const trackOrder = (o) => { if (o?.id != null) createdOrders.add(o.id); if (o?.pos_id) createdTickets.add(o.pos_id); if (o?.omnivore_pos_id) createdTickets.add(o.omnivore_pos_id); };
  const ticketItems = async (tid) => { const r = await ax.get(`/tickets/${tid}`, { params: { fields: 'items(id)' } }); return (r.data?._embedded?.items ?? []).length; };
  const orderRow = async (id) => (await c.query(`select id, pos_id, omnivore_pos_id, status, line_items, additional_properties from orders where id=$1 and site_id=$2`, [id, SITE])).rows[0];
  const countByKey = async (k) => Number((await c.query(`select count(*) n from orders where site_id=$1 and additional_properties->>'idempotency_key'=$2`, [SITE, k])).rows[0].n);

  console.log(`\n################ E2E ${TOK} (edges DEV + Aloha) ################\n`);

  // ── T1: open-table dedup (misma llave → 1 orden) ──────────────────────────
  let order1;
  {
    const K = `${TOK}-openA`; idemKeys.push(K); usedTables.add(T.openA);
    const r1 = await edge('open-table-order', { table_id: T.openA, guests: 2, employee: { id: '975', first_name: 'E2E' } }, K);
    await sleep(1500);
    const r2 = await edge('open-table-order', { table_id: T.openA, guests: 2, employee: { id: '975', first_name: 'E2E' } }, K);
    const id1 = r1.data?.order?.id, id2 = r2.data?.order?.id;
    trackOrder(r1.data?.order); trackOrder(r2.data?.order);
    order1 = await orderRow(id1);
    const n = await countByKey(K);
    if (r1.status === 200 && id1 && id2 === id1 && n === 1) ok('openTable.dedup', `misma llave → MISMA orden ${id1}, 1 fila en DB (r2=${r2.status})`);
    else no('openTable.dedup', `r1=${r1.status}/${id1} r2=${r2.status}/${id2} count=${n}`);
  }

  // ── T2: open-tab dedup ────────────────────────────────────────────────────
  {
    const K = `${TOK}-tab`; idemKeys.push(K);
    const name = `E2E${TOK}`.slice(0, 14);
    const r1 = await edge('open-tab', { experience_reference: name, employee: { id: '975', first_name: 'E2E' } }, K);
    await sleep(1500);
    const r2 = await edge('open-tab', { experience_reference: name, employee: { id: '975', first_name: 'E2E' } }, K);
    const id1 = r1.data?.order?.id, id2 = r2.data?.order?.id;
    trackOrder(r1.data?.order); trackOrder(r2.data?.order);
    const n = await countByKey(K);
    if (r1.status === 200 && id1 && id2 === id1 && n === 1) ok('openTab.dedup', `misma llave → MISMO tab ${id1}, 1 fila (r2=${r2.status})`);
    else no('openTab.dedup', `r1=${r1.status}/${id1} r2=${r2.status}/${id2} count=${n}`);
  }

  // ── T3: send-to-kitchen dedup (happy) + control stamp ─────────────────────
  {
    const Kf = `${TOK}-fire`;
    // orden fresca en otra mesa + producto
    const ro = await edge('open-table-order', { table_id: T.fire, guests: 1, employee: { id: '975', first_name: 'E2E' } }, `${TOK}-fireOpen`);
    idemKeys.push(`${TOK}-fireOpen`); usedTables.add(T.fire); trackOrder(ro.data?.order);
    const oid = ro.data?.order?.id;
    const ra = await edge('add-products-to-order', { order_id: oid, line_items: [{ product_id: PROD, quantity: 1 }] }, `${TOK}-fireAdd`);
    const lines = ra.data?.order?.line_items ?? [];
    const L = lines.find((x) => String(x.product_id) === String(PROD))?.id ?? lines[lines.length - 1]?.id;
    if (!oid || !L) { no('fire.dedup', `setup falló: oid=${oid} L=${L} add=${ra.status} ${JSON.stringify(ra.data).slice(0,200)}`); }
    else {
      const f1 = await edge('send-to-kitchen', { order_id: oid, line_item_ids: [L], employee: { id: '975', first_name: 'E2E' } }, Kf);
      await sleep(1800);
      const row = await orderRow(oid); const tid = row?.pos_id || row?.omnivore_pos_id; if (tid) createdTickets.add(tid);
      const c1 = tid ? await ticketItems(tid) : -1;
      const f2 = await edge('send-to-kitchen', { order_id: oid, line_item_ids: [L], employee: { id: '975', first_name: 'E2E' } }, Kf);
      await sleep(1800);
      const c2 = tid ? await ticketItems(tid) : -1;
      const stampedRow = await orderRow(oid);
      const stamped = (stampedRow?.line_items ?? []).find((x) => x.id === L)?.additional_properties?.omnivore?.item_id;
      if (f1.status === 200 && c1 >= 1 && c2 === c1 && stamped) ok('fire.dedup', `misma llave: ítems estable ${c1}→${c2}, línea estampada (${stamped}); f2=${f2.status} (hit)`);
      else no('fire.dedup', `f1=${f1.status} c1=${c1} f2=${f2.status} c2=${c2} stamped=${stamped}`);

      // control: NUEVA llave, misma línea (ya estampada) → toFire vacío → NO duplica
      const f3 = await edge('send-to-kitchen', { order_id: oid, line_item_ids: [L], employee: { id: '975', first_name: 'E2E' } }, `${TOK}-fire3`);
      await sleep(1500);
      const c3 = tid ? await ticketItems(tid) : -1;
      if (c3 === c1) ok('fire.stampGuard', `llave distinta + línea ya estampada → sin duplicado (${c3}); guard por-línea OK`);
      else no('fire.stampGuard', `c1=${c1} c3=${c3}`);
    }
  }

  // ── T4: send-to-kitchen RECONCILE (crash/stale: item ya aterrizó) ─────────
  {
    const ro = await edge('open-table-order', { table_id: T.recon, guests: 1, employee: { id: '975', first_name: 'E2E' } }, `${TOK}-reconOpen`);
    idemKeys.push(`${TOK}-reconOpen`); usedTables.add(T.recon); trackOrder(ro.data?.order);
    const oid = ro.data?.order?.id;
    const ra = await edge('add-products-to-order', { order_id: oid, line_items: [{ product_id: PROD, quantity: 1 }] }, `${TOK}-reconAdd`);
    const lines = ra.data?.order?.line_items ?? [];
    const M = lines.find((x) => String(x.product_id) === String(PROD))?.id ?? lines[lines.length - 1]?.id;
    const row = await orderRow(oid); const tid = row?.pos_id || row?.omnivore_pos_id; if (tid) createdTickets.add(tid);
    if (!oid || !M || !tid) { no('fire.reconcile', `setup: oid=${oid} M=${M} tid=${tid}`); }
    else {
      // simular el "fire previo que aterrizó": POST directo del ítem al ticket
      await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: '300015', quantity: 1, item_order_mode: cfg.defaultOrderTypeId, auto_send: true }] }, { headers: { 'Idempotency-Id': `${TOK}-reconpre` } });
      await sleep(1800);
      const before = await ticketItems(tid);
      // claim STALE: insertar in_flight viejo para la llave de fire
      const Kr = `${TOK}-reconFire`;
      await c.query(`insert into idempotency_keys(key,route,status,locked_at,response) values($1,'send-to-kitchen','in_flight', now()-interval '200 seconds', null) on conflict (key,route) do update set status='in_flight', locked_at=now()-interval '200 seconds', response=null`, [Kr]);
      const fr = await edge('send-to-kitchen', { order_id: oid, line_item_ids: [M], employee: { id: '975', first_name: 'E2E' } }, Kr);
      await sleep(1800);
      const after = await ticketItems(tid);
      const stampedRow = await orderRow(oid);
      const stamped = (stampedRow?.line_items ?? []).find((x) => x.id === M)?.additional_properties?.omnivore?.item_id;
      if (fr.status === 200 && after === before && stamped) ok('fire.reconcile', `claim stale: ítem ya en ticket NO se re-fireó (${before}→${after}), línea estampada desde el id vivo (${stamped})`);
      else no('fire.reconcile', `fr=${fr.status} before=${before} after=${after} stamped=${stamped} ${JSON.stringify(fr.data).slice(0,150)}`);
    }
  }

  // ── T5: void dedup (línea sin firear → sin pin; misma llave → already/hit) ─
  {
    const ro = await edge('open-table-order', { table_id: T.void, guests: 1, employee: { id: '975', first_name: 'E2E' } }, `${TOK}-voidOpen`);
    idemKeys.push(`${TOK}-voidOpen`); usedTables.add(T.void); trackOrder(ro.data?.order);
    const oid = ro.data?.order?.id;
    const ra = await edge('add-products-to-order', { order_id: oid, line_items: [{ product_id: PROD, quantity: 1 }] }, `${TOK}-voidAdd`);
    const lines = ra.data?.order?.line_items ?? [];
    const V = lines.find((x) => String(x.product_id) === String(PROD))?.id ?? lines[lines.length - 1]?.id;
    const row = await orderRow(oid); const tid = row?.pos_id || row?.omnivore_pos_id; if (tid) createdTickets.add(tid);
    if (!oid || !V) { no('void.dedup', `setup: oid=${oid} V=${V}`); }
    else {
      const Kv = `${TOK}-void`;
      const v1 = await edge('void-line-item', { order_id: oid, line_item_id: V, reason: 'e2e', employee: { id: '975', first_name: 'E2E' } }, Kv);
      await sleep(1200);
      const v2 = await edge('void-line-item', { order_id: oid, line_item_id: V, reason: 'e2e', employee: { id: '975', first_name: 'E2E' } }, Kv);
      const after = await orderRow(oid);
      const lst = (after?.line_items ?? []).find((x) => x.id === V)?.status;
      if (v1.status === 200 && v2.status === 200 && v1.data?.ok && v2.data?.ok && lst === 'voided') ok('void.dedup', `void ×2 misma llave → ambos ok, línea 'voided' (v1=${v1.status} v2=${v2.status})`);
      else no('void.dedup', `v1=${v1.status}/${JSON.stringify(v1.data).slice(0,120)} v2=${v2.status} lineStatus=${lst}`);
    }
  }

  // ── T6: concurrencia (misma llave en paralelo → 1 orden) ──────────────────
  {
    const K = `${TOK}-conc`; idemKeys.push(K); usedTables.add(T.conc);
    const body = { table_id: T.conc, guests: 1, employee: { id: '975', first_name: 'E2E' } };
    const [a, b] = await Promise.all([edge('open-table-order', body, K), edge('open-table-order', body, K)]);
    await sleep(1500);
    trackOrder(a.data?.order); trackOrder(b.data?.order);
    const n = await countByKey(K);
    const statuses = [a.status, b.status].sort().join(',');
    // resultado válido: exactamente 1 orden creada (uno 200, el otro 200-hit o 409 in_flight)
    if (n === 1) ok('concurrency', `paralelo misma llave → EXACTAMENTE 1 orden (statuses ${statuses})`);
    else no('concurrency', `count=${n} statuses=${statuses}`);
  }

  // ── T7: stale-recovery open (in_flight viejo + orden existe → adopta, no 2ª) ─
  {
    const K = `${TOK}-staleOpen`; idemKeys.push(K);
    // 1er open normal
    const r1 = await edge('open-table-order', { table_id: T.stale, guests: 1, employee: { id: '975', first_name: 'E2E' } }, K);
    await sleep(1500); trackOrder(r1.data?.order);
    const id1 = r1.data?.order?.id;
    // forzar la fila a in_flight viejo (simula crash antes de finish)
    await c.query(`update idempotency_keys set status='in_flight', locked_at=now()-interval '200 seconds', response=null where key=$1 and route='open-table-order'`, [K]);
    const r2 = await edge('open-table-order', { table_id: T.stale, guests: 1, employee: { id: '975', first_name: 'E2E' } }, K);
    await sleep(1200); trackOrder(r2.data?.order);
    const id2 = r2.data?.order?.id;
    const n = await countByKey(K);
    if (id1 && id2 === id1 && n === 1) ok('stale.recovery', `claim stale → ADOPTÓ la orden ${id1} por llave (no creó 2ª); count=${n} r2=${r2.status}`);
    else no('stale.recovery', `id1=${id1} id2=${id2} count=${n} r2=${r2.status}`);
  }

  // ── CLEANUP ────────────────────────────────────────────────────────────────
  console.log('\n--- cleanup ---');
  // cerrar tickets Omnivore (pagar saldo) y borrar órdenes MCM + liberar mesas
  for (const tid of createdTickets) {
    try { const t = await ax.get(`/tickets/${tid}`, { params: { fields: 'totals(due),open' } }); const due = Number(t.data?.totals?.due ?? 0); if (t.data?.open !== false && due > 0) await ax.post(`/tickets/${tid}/payments`, { type: '3rd_party', tender_type: cfg.defaultTenderId, amount: due, tip: 0, comment: 'e2e-cl' }, { headers: { 'Idempotency-Id': `e2ecl-${tid}` } }); } catch {}
  }
  for (const oid of createdOrders) { try { await c.query(`delete from orders where id=$1 and site_id=$2`, [oid, SITE]); } catch {} }
  for (const tbl of usedTables) { try { await c.query(`update floor_elements set status='available' where id=$1 and site_id=$2`, [tbl, SITE]); } catch {} }
  for (const k of idemKeys) { try { await c.query(`delete from idempotency_keys where key like $1`, [`${k}%`]); } catch {} }
  await c.query(`delete from idempotency_keys where key like $1`, [`${TOK}-%`]);
  console.log(`cleaned: ${createdOrders.size} orders, ${createdTickets.size} tickets, ${usedTables.size} tables freed`);
  await c.end();

  console.log(`\n===== E2E RESULT: ${pass.length} pass / ${fail.length} fail =====`);
  if (fail.length) { console.log('FAILS:', fail.join(', ')); process.exit(1); }
})().catch((e) => { console.error('FATAL', e.response?.status, e.message, JSON.stringify(e.response?.data)); process.exit(1); });
