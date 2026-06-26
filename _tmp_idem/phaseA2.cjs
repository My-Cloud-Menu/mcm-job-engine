/** Fase A (correcciones): F1 con mesa (managed=true) + F5 void con PIN real. */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');
const SITE = 55126712, TOK = Date.now().toString(36).slice(-5).toUpperCase();
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY, SUPA = process.env.SUPABASE_URL;
const MGR_PIN = '1116', PROD = 10002, MENU = '300015';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [], fail = [], findings = [];
const ok = (n, d) => { pass.push(n); console.log(`✅ ${n} — ${d}`); };
const no = (n, d) => { fail.push(n); findings.push(`[${n}] ${d}`); console.log(`❌ ${n} — ${d}`); };
const edge = async (slug, body, key) => axios.post(`${SUPA}/functions/v1/${slug}`, { site_id: SITE, ...body, ...(key ? { idempotency_key: key } : {}) }, { headers: { Authorization: `Bearer ${SR}`, apikey: SR, 'Content-Type': 'application/json' }, validateStatus: () => true });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const cfg = (await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE])).rows[0].config;
  const ax = axios.create({ baseURL: `https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`, headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
  const orderRow = async (id) => (await c.query(`select * from orders where id=$1 and site_id=$2`, [id, SITE])).rows[0];
  const orderByPos = async (pos) => (await c.query(`select * from orders where site_id=$1 and omnivore_pos_id=$2`, [SITE, pos])).rows;
  const createdOrders = new Set(), createdTickets = new Set(), usedTables = new Set();

  // ── F1b: ticket POS CON MESA → sync → managed=true ──
  {
    const tbl = (await c.query(`select id, external_id from floor_elements where site_id=$1 and type='table' and status='available' and external_id is not null order by table_number limit 1`, [SITE])).rows[0];
    const tk = await ax.post('/tickets', { employee: cfg.defaultEmployeeId, order_type: cfg.defaultOrderTypeId, revenue_center: cfg.defaultRevenueCenterId, table: tbl.external_id, name: `POS${TOK}T`.slice(0, 14), auto_send: false });
    const tid = tk.data?.id;
    if (!tid) { no('F1b.posDineIn', `no creó ticket con mesa: ${JSON.stringify(tk.data?.errors)}`); }
    else {
      createdTickets.add(tid); usedTables.add(tbl.id);
      await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: MENU, quantity: 1, item_order_mode: cfg.defaultOrderTypeId, auto_send: true }] }, { headers: { 'Idempotency-Id': `${TOK}-f1b` } });
      console.log(`F1b: ticket POS dine-in ${tid} (mesa ${tbl.external_id}); esperando sync...`);
      const t0 = Date.now(); let rows = [];
      while (Date.now() - t0 < 95000) { rows = await orderByPos(tid); if (rows.length) break; await sleep(5000); }
      rows.forEach((o) => createdOrders.add(o.id));
      const o = rows[0];
      const managed = o?.additional_properties?.omnivore_managed === true;
      if (rows.length === 1 && managed && o.experience === 'qe') ok('F1b.posDineIn', `POS dine-in con mesa → 1 orden MCM managed (${o.id}), experience=qe (editable desde O&P)`);
      else no('F1b.posDineIn', `rows=${rows.length} managed=${managed} exp=${o?.experience}`);
    }
  }

  // ── F5b: void de ítem fireado con PIN real (Aloha → void local + "anular en terminal") ──
  {
    const t = (await c.query(`select id from floor_elements where site_id=$1 and type='table' and status='available' order by table_number limit 1 offset 3`, [SITE])).rows[0];
    usedTables.add(t.id);
    const ro = await edge('open-table-order', { table_id: t.id, guests: 1, employee: { id: '975', first_name: 'A' } }, `${TOK}-f5bOpen`);
    const oid = ro.data?.order?.id; if (oid) createdOrders.add(oid);
    await sleep(1200);
    const row0 = await orderRow(oid); const tid = row0?.pos_id || row0?.omnivore_pos_id; if (tid) createdTickets.add(tid);
    const ra = await edge('add-products-to-order', { order_id: oid, line_items: [{ product_id: PROD, quantity: 1 }] }, `${TOK}-f5bAdd`);
    const L = (ra.data?.order?.line_items ?? []).filter((x) => String(x.product_id) === String(PROD)).slice(-1)[0]?.id;
    const f = await edge('send-to-kitchen', { order_id: oid, line_item_ids: [L], employee: { id: '975', first_name: 'A' } }, `${TOK}-f5bFire`);
    await sleep(1800);
    const v = await edge('void-line-item', { order_id: oid, line_item_id: L, reason: 'audit', manager_pin: MGR_PIN, employee: { id: '975', first_name: 'A' } }, `${TOK}-f5bVoid`);
    await sleep(1500);
    const vs = (await orderRow(oid))?.line_items?.find((x) => x.id === L);
    const voided = vs?.status === 'voided';
    if (v.status === 200 && v.data?.ok && voided) {
      const warn = v.data?.warning ? ' (con warning "anular en terminal" — correcto en Aloha p/ítem fireado)' : '';
      ok('F5b.voidFiredPin', `void con PIN manager OK: línea 'voided'${warn}; sync_status=${vs?.additional_properties?.omnivore?.sync_status}`);
    } else no('F5b.voidFiredPin', `v=${v.status} ok=${v.data?.ok} voided=${voided} ${JSON.stringify(v.data).slice(0,140)}`);
  }

  // cleanup
  console.log('\n--- cleanup ---');
  for (const tid of createdTickets) { try { const t = await ax.get(`/tickets/${tid}`, { params: { fields: 'totals(due),open' } }); const due = Number(t.data?.totals?.due ?? 0); if (t.data?.open !== false && due > 0) await ax.post(`/tickets/${tid}/payments`, { type: '3rd_party', tender_type: cfg.defaultTenderId, amount: due, tip: 0, comment: 'A2cl' }, { headers: { 'Idempotency-Id': `A2cl-${tid}` } }); } catch {} }
  for (const oid of createdOrders) { try { await c.query(`update orders set closed_at=now(), status='check-closed' where id=$1 and site_id=$2 and closed_at is null`, [oid, SITE]); } catch {} }
  for (const t of usedTables) { try { await c.query(`update floor_elements set status='available' where id=$1 and site_id=$2`, [t, SITE]); } catch {} }
  await c.query(`delete from idempotency_keys where key like $1`, [`${TOK}-%`]);
  await c.end();
  console.log(`\n===== FASE A2: ${pass.length} pass / ${fail.length} fail =====`);
  if (findings.length) console.log('HALLAZGOS:\n' + findings.map((f) => '  - ' + f).join('\n'));
})().catch((e) => { console.error('FATAL', e.response?.status, e.message, JSON.stringify(e.response?.data)); process.exit(1); });
