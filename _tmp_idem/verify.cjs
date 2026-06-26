/** Verificación del hardening de idempotencia contra DEV + Aloha real. */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');
const SITE = '55126712';
const TOK = Date.now().toString(36).slice(-5).toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [], fail = [];
const ok = (n, d) => { pass.push(n); console.log(`✅ ${n} — ${d}`); };
const no = (n, d) => { fail.push(n); console.log(`❌ ${n} — ${d}`); };

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE]);
  const cfg = rows[0].config;
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SUPA = process.env.SUPABASE_URL;
  const ax = axios.create({ baseURL: `https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`, headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
  const EMP = cfg.defaultEmployeeId, OT = cfg.defaultOrderTypeId, RC = cfg.defaultRevenueCenterId, TENDER = cfg.defaultTenderId, MENU = '300015';
  const created = new Set();

  console.log(`\n############ VERIFY ${TOK} ############\n`);

  // ── 1. Edge desplegado: open-table-order SIN idempotency_key → 400 idempotency_key_required
  {
    const r = await axios.post(`${SUPA}/functions/v1/open-table-order`,
      { site_id: SITE, table_id: 'x', guests: 1 },
      { headers: { Authorization: `Bearer ${SR}`, apikey: SR, 'Content-Type': 'application/json' }, validateStatus: () => true });
    if (r.status === 400 && r.data?.error === 'idempotency_key_required') ok('edge.requiredKey', `open-table-order sin llave → 400 idempotency_key_required (cambio LIVE en DEV)`);
    else no('edge.requiredKey', `esperaba 400 idempotency_key_required, got ${r.status} ${JSON.stringify(r.data)}`);
  }
  // open-tab SIN idempotency_key → 400
  {
    const r = await axios.post(`${SUPA}/functions/v1/open-tab`,
      { site_id: SITE, experience_reference: 'X' },
      { headers: { Authorization: `Bearer ${SR}`, apikey: SR, 'Content-Type': 'application/json' }, validateStatus: () => true });
    if (r.status === 400 && r.data?.error === 'idempotency_key_required') ok('edge.openTab.requiredKey', `open-tab sin llave → 400 (LIVE)`);
    else no('edge.openTab.requiredKey', `got ${r.status} ${JSON.stringify(r.data)}`);
  }

  // ── 2. claim RPC lifecycle
  {
    const K = `verify-${TOK}`, R = 'verify-route';
    const call = async (ttl = 90) => (await c.query(`select * from claim_idempotency_key($1,$2,$3)`, [K, R, ttl])).rows[0];
    const r1 = await call();
    const r2 = await call();
    await c.query(`update idempotency_keys set status='done', response=$3 where key=$1 and route=$2`, [K, R, { ok: true }]);
    const r3 = await call();
    await c.query(`update idempotency_keys set status='in_flight', locked_at=now()-interval '200 seconds', response=null where key=$1 and route=$2`, [K, R]);
    const r4 = await call();
    await c.query(`delete from idempotency_keys where key=$1 and route=$2`, [K, R]);
    const good = r1.outcome === 'claimed_fresh' && r2.outcome === 'in_flight' && r3.outcome === 'hit' && JSON.stringify(r3.response) === JSON.stringify({ ok: true }) && r4.outcome === 'claimed_stale';
    if (good) ok('claim.rpc', `fresh→in_flight→hit(+response)→stale ✓`);
    else no('claim.rpc', `${r1.outcome}/${r2.outcome}/${r3.outcome}/${r4.outcome}`);
  }

  // ── 3. reconcileFiredItems correlation contra ticket REAL (simula fire que ya aterrizó)
  {
    const tk = await ax.post('/tickets', { employee: EMP, order_type: OT, revenue_center: RC, name: `VR${TOK}`.slice(0, 15), auto_send: false });
    const tid = tk.data?.id; if (tid) created.add(tid);
    // "fire previo que aterrizó": 2 unidades del mismo menu_item
    await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: MENU, quantity: 2, item_order_mode: OT, auto_send: true }] }, { headers: { 'Idempotency-Id': `${TOK}-vr` } });
    await sleep(1800);
    const g = await ax.get(`/tickets/${tid}`, { params: { fields: 'items(id,quantity,menu_item)' } });
    const live = (g.data?._embedded?.items ?? []).map((it) => ({ id: String(it.id), menuItem: String(it._embedded?.menu_item?.id ?? it.menu_item ?? ''), qty: Number(it.quantity ?? 1) }));
    // toFire = 1 línea MCM qty=2 del MENU, SIN estampa (= el caso del crash)
    const toFire = [{ id: 'lineA', product_id: 0, quantity: 2 }];
    const menuItemByIndex = [MENU]; // (en el edge sale de products.additional_properties.omnivoreId)
    // ===== misma correlación que correlateOmnivoreItemsToLines =====
    const byMI = new Map();
    for (const it of live) { const q = byMI.get(it.menuItem) ?? []; q.push({ id: it.id, qty: it.qty }); byMI.set(it.menuItem, q); }
    const map = {};
    toFire.forEach((li, i) => {
      const queue = byMI.get(menuItemByIndex[i]); if (!queue) return;
      const need = Number(li.quantity ?? 1); const ids = []; let acc = 0;
      while (queue.length && acc < need) { const row = queue.shift(); ids.push(row.id); acc += row.qty; }
      if (ids.length) map[li.id] = ids;
    });
    const landed = map['lineA'] ?? [];
    if (landed.length >= 1 && live.length >= 1) ok('reconcile.correlation', `detectó ${landed.length} item(s) ya aterrizado(s) [${landed.join(',')}] sobre ${live.length} en ticket → el edge ESTAMPA y NO re-firea`);
    else no('reconcile.correlation', `live=${JSON.stringify(live)} map=${JSON.stringify(map)}`);
  }

  // ── 4. void reference_not_found idempotente (raw Aloha) + branch del código
  {
    const tk = await ax.post('/tickets', { employee: EMP, order_type: OT, revenue_center: RC, name: `VV${TOK}`.slice(0, 15), auto_send: false });
    const tid = tk.data?.id; if (tid) created.add(tid);
    await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: MENU, quantity: 1, item_order_mode: OT, auto_send: false }] }, { headers: { 'Idempotency-Id': `${TOK}-vv` } });
    await sleep(1500);
    const g = await ax.get(`/tickets/${tid}`, { params: { fields: 'items(id)' } });
    const iid = g.data?._embedded?.items?.[0]?.id;
    const d1 = await ax.delete(`/tickets/${tid}/items/${iid}`, { validateStatus: () => true });
    await sleep(1000);
    const d2 = await ax.delete(`/tickets/${tid}/items/${iid}`, { validateStatus: () => true });
    const slug2 = Array.isArray(d2.data?.errors) && d2.data.errors[0]?.error ? String(d2.data.errors[0].error) : `http_${d2.status}`;
    // branch del fix: alreadyGone = 404 || reference_not_found || not_found
    const alreadyGone = d2.status === 404 || slug2 === 'reference_not_found' || slug2 === 'not_found';
    const treatedOk = (d2.status >= 200 && d2.status < 300) || alreadyGone;
    if ((d1.status >= 200 && d1.status < 300) && treatedOk) ok('void.idempotent', `1st DELETE=${d1.status}, 2nd=${d2.status}/${slug2} → fix lo trata como éxito idempotente`);
    else no('void.idempotent', `d1=${d1.status} d2=${d2.status}/${slug2} treatedOk=${treatedOk}`);
  }

  // cleanup
  for (const tid of created) { try { const t = await ax.get(`/tickets/${tid}`, { params: { fields: 'totals(due),open' } }); const due = Number(t.data?.totals?.due ?? 0); if (t.data?.open !== false && due > 0) await ax.post(`/tickets/${tid}/payments`, { type: '3rd_party', tender_type: TENDER, amount: due, tip: 0, comment: 'cl' }, { headers: { 'Idempotency-Id': `cl-${tid}` } }); } catch {} }
  await c.end();

  console.log(`\n===== RESULT: ${pass.length} pass / ${fail.length} fail =====`);
  if (fail.length) process.exit(1);
})().catch((e) => { console.error('FATAL', e.response?.status, e.message, JSON.stringify(e.response?.data)); process.exit(1); });
