/**
 * AUDITORÍA BIDIRECCIONAL — Fase A (funcional).
 * Cubre: ticket POS-originado (Omnivore→MCM por sync), crear desde MCM, fire, POS agrega
 * ítem→merge inbound, void desde MCM, crear el mismo ticket 2 veces, carrera create.
 * Edges DEV (token service_role) + Aloha real + DB. Limpia todo al final.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');
const SITE = 55126712;
const TOK = Date.now().toString(36).slice(-5).toUpperCase();
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY, SUPA = process.env.SUPABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [], fail = [], findings = [];
const ok = (n, d) => { pass.push(n); console.log(`✅ ${n} — ${d}`); };
const no = (n, d) => { fail.push(n); findings.push(`[${n}] ${d}`); console.log(`❌ ${n} — ${d}`); };
const PROD = 10002, MENU = '300015';

const edge = async (slug, body, key) => axios.post(`${SUPA}/functions/v1/${slug}`,
  { site_id: SITE, ...body, ...(key ? { idempotency_key: key } : {}) },
  { headers: { Authorization: `Bearer ${SR}`, apikey: SR, 'Content-Type': 'application/json' }, validateStatus: () => true });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const cfg = (await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE])).rows[0].config;
  const ax = axios.create({ baseURL: `https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`, headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
  const tables = (await c.query(`select id, external_id from floor_elements where site_id=$1 and type='table' and status='available' order by table_number limit 10`, [SITE])).rows;
  let ti = 0; const nextTable = () => tables[ti++];
  const createdOrders = new Set(), createdTickets = new Set(), usedTables = new Set();
  const tItems = async (tid) => (await ax.get(`/tickets/${tid}`, { params: { fields: 'items(id)' } })).data?._embedded?.items?.length ?? 0;
  const orderByPos = async (pos) => (await c.query(`select * from orders where site_id=$1 and omnivore_pos_id=$2`, [SITE, pos])).rows;
  const orderRow = async (id) => (await c.query(`select * from orders where id=$1 and site_id=$2`, [id, SITE])).rows[0];
  const pollOrderByPos = async (pos, ms = 95000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await orderByPos(pos); if (r.length) return r; await sleep(5000); } return []; };

  console.log(`\n################ FASE A — BIDIRECCIONAL ${TOK} ################\n`);

  // ── F1: ticket POS-originado en Omnivore → sync → orden MCM (inbound) ──────
  {
    const tk = await ax.post('/tickets', { employee: cfg.defaultEmployeeId, order_type: cfg.defaultOrderTypeId, revenue_center: cfg.defaultRevenueCenterId, name: `POS${TOK}1`.slice(0, 14), auto_send: false });
    const tid = tk.data?.id; if (tid) createdTickets.add(tid);
    await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: MENU, quantity: 2, item_order_mode: cfg.defaultOrderTypeId, auto_send: true }] }, { headers: { 'Idempotency-Id': `${TOK}-f1` } });
    console.log(`F1: ticket POS ${tid} creado en Omnivore con 2 ítems; esperando sync (≤95s)...`);
    const rows = await pollOrderByPos(tid);
    if (rows.length === 1) {
      rows.forEach((o) => createdOrders.add(o.id));
      const o = rows[0];
      const items = Array.isArray(o.line_items) ? o.line_items : [];
      const mapped = items.filter((i) => String(i.product_id) === String(PROD)).length;
      const managed = o.additional_properties?.omnivore_managed === true;
      if (mapped >= 1 && managed) ok('F1.posOriginated', `sync creó 1 orden MCM (${o.id}) managed, ${items.length} líneas (${mapped} mapeadas al product real)`);
      else no('F1.posOriginated', `orden creada pero items=${items.length} mapped=${mapped} managed=${managed}`);
    } else no('F1.posOriginated', `esperaba 1 orden por sync, encontró ${rows.length}`);
  }

  // ── F2/F3: crear desde MCM + fire ─────────────────────────────────────────
  let mcmOrderId, mcmTicketId;
  {
    const t = nextTable(); usedTables.add(t.id);
    const ro = await edge('open-table-order', { table_id: t.id, guests: 2, employee: { id: '975', first_name: 'A' } }, `${TOK}-f2`);
    mcmOrderId = ro.data?.order?.id; if (mcmOrderId) createdOrders.add(mcmOrderId);
    await sleep(1500);
    const row = await orderRow(mcmOrderId); mcmTicketId = row?.pos_id || row?.omnivore_pos_id; if (mcmTicketId) createdTickets.add(mcmTicketId);
    if (ro.status === 200 && mcmTicketId) ok('F2.mcmCreate', `MCM creó orden ${mcmOrderId} + ticket Omnivore ${mcmTicketId}`);
    else no('F2.mcmCreate', `ro=${ro.status} pos=${mcmTicketId}`);

    const ra = await edge('add-products-to-order', { order_id: mcmOrderId, line_items: [{ product_id: PROD, quantity: 1 }] }, `${TOK}-f3a`);
    const L = (ra.data?.order?.line_items ?? []).filter((x) => String(x.product_id) === String(PROD)).slice(-1)[0]?.id;
    const before = mcmTicketId ? await tItems(mcmTicketId) : 0;
    const f = await edge('send-to-kitchen', { order_id: mcmOrderId, line_item_ids: [L], employee: { id: '975', first_name: 'A' } }, `${TOK}-f3f`);
    await sleep(1800);
    const after = mcmTicketId ? await tItems(mcmTicketId) : 0;
    const stamped = (await orderRow(mcmOrderId))?.line_items?.find((x) => x.id === L)?.additional_properties?.omnivore?.item_id;
    if (f.status === 200 && after > before && stamped) ok('F3.fire', `fire desde MCM: ítems ticket ${before}→${after}, línea estampada (${stamped})`);
    else no('F3.fire', `f=${f.status} before=${before} after=${after} stamped=${stamped}`);
  }

  // ── F4: el POS agrega un ítem DIRECTO al ticket gestionado por MCM → merge ──
  {
    if (!mcmTicketId) no('F4.posAddMerge', 'sin ticket de F2');
    else {
      const beforeRow = await orderRow(mcmOrderId);
      const beforeLines = (beforeRow?.line_items ?? []).length;
      await ax.post(`/tickets/${mcmTicketId}/items`, { items: [{ menu_item: '300025', quantity: 1, item_order_mode: cfg.defaultOrderTypeId, auto_send: true }] }, { headers: { 'Idempotency-Id': `${TOK}-f4` } }); // Elote (POS-add)
      // bump synced_at viejo para que el merge no salte por freshness
      await c.query(`update orders set additional_properties = jsonb_set(coalesce(additional_properties,'{}'), '{omnivore_synced_at}', to_jsonb((now()-interval '120 seconds')::text)) where id=$1 and site_id=$2`, [mcmOrderId, SITE]);
      console.log(`F4: POS agregó Elote directo al ticket ${mcmTicketId}; esperando merge inbound (≤95s)...`);
      const t0 = Date.now(); let merged = false, finalLines = beforeLines;
      while (Date.now() - t0 < 95000) {
        const r = await orderRow(mcmOrderId);
        const lines = (r?.line_items ?? []);
        const hasPosAdd = lines.some((x) => String(x.product_id) === '10004' || x.additional_properties?.omnivore?.origin === 'pos');
        finalLines = lines.length;
        if (hasPosAdd && lines.length > beforeLines) { merged = true; break; }
        await sleep(5000);
      }
      if (merged) ok('F4.posAddMerge', `merge inbound adoptó el ítem agregado por el POS (líneas ${beforeLines}→${finalLines})`);
      else no('F4.posAddMerge', `el ítem POS no apareció en la orden MCM tras 95s (líneas ${beforeLines}→${finalLines})`);
    }
  }

  // ── F5: void desde MCM de un ítem fireado ─────────────────────────────────
  {
    const row = await orderRow(mcmOrderId);
    const sentLine = (row?.line_items ?? []).find((x) => x.status === 'sent' && x.additional_properties?.omnivore?.item_id);
    if (!sentLine) no('F5.void', 'no hay línea sent con item_id para anular');
    else {
      const pin = cfg.managerPin || '1234'; // intento; si falla por pin, lo reportamos
      const before = mcmTicketId ? await tItems(mcmTicketId) : 0;
      let v = await edge('void-line-item', { order_id: mcmOrderId, line_item_id: sentLine.id, reason: 'audit', manager_pin: pin, employee: { id: '975', first_name: 'A' } }, `${TOK}-f5`);
      await sleep(1800);
      const after = mcmTicketId ? await tItems(mcmTicketId) : 0;
      const vs = (await orderRow(mcmOrderId))?.line_items?.find((x) => x.id === sentLine.id)?.status;
      if (v.status === 200 && vs === 'voided') ok('F5.void', `void OK: línea 'voided'; ítems ticket ${before}→${after} (v=${v.status})`);
      else if (v.status === 400 && v.data?.error === 'manager_pin_required') no('F5.void', `requiere manager_pin válido (no disponible en config); flujo correcto pero no verificable aquí`);
      else if (v.data?.error === 'invalid_pin' || v.status === 401) no('F5.void', `manager_pin de prueba inválido — flujo de void correcto pero PIN no verificable; reintentar con PIN real`);
      else no('F5.void', `v=${v.status} ${JSON.stringify(v.data).slice(0,140)} status=${vs}`);
    }
  }

  // ── F6: crear el mismo ticket 2 veces (idempotencia) ──────────────────────
  {
    const t = nextTable(); usedTables.add(t.id);
    const K = `${TOK}-f6`;
    const r1 = await edge('open-table-order', { table_id: t.id, guests: 1, employee: { id: '975', first_name: 'A' } }, K);
    await sleep(1200);
    const r2 = await edge('open-table-order', { table_id: t.id, guests: 1, employee: { id: '975', first_name: 'A' } }, K);
    const id1 = r1.data?.order?.id, id2 = r2.data?.order?.id;
    if (id1) createdOrders.add(id1);
    const n = Number((await c.query(`select count(*) n from orders where site_id=$1 and additional_properties->>'idempotency_key'=$2`, [SITE, K])).rows[0].n);
    const row = id1 ? await orderRow(id1) : null; if (row?.pos_id) createdTickets.add(row.pos_id);
    if (id1 && id2 === id1 && n === 1) ok('F6.createTwice', `mismo ticket 2× → 1 orden (${id1}), 1 ticket`);
    else no('F6.createTwice', `id1=${id1} id2=${id2} n=${n}`);
  }

  // ── F7: carrera create (open + ciclo de sync) → sin duplicado ─────────────
  {
    const t = nextTable(); usedTables.add(t.id);
    const K = `${TOK}-f7`;
    const r = await edge('open-table-order', { table_id: t.id, guests: 1, employee: { id: '975', first_name: 'A' } }, K);
    const oid = r.data?.order?.id; if (oid) createdOrders.add(oid);
    await sleep(1500);
    const row = await orderRow(oid); const pos = row?.pos_id || row?.omnivore_pos_id; if (pos) createdTickets.add(pos);
    console.log(`F7: orden ${oid} ticket ${pos}; esperando 2 ciclos de sync para ver si duplica...`);
    await sleep(70000);
    const dup = pos ? (await orderByPos(pos)).length : 0;
    if (dup === 1) ok('F7.createRace', `tras ciclos de sync: EXACTAMENTE 1 orden por ticket ${pos} (link-by-name evitó duplicado)`);
    else no('F7.createRace', `${dup} órdenes para ticket ${pos} (esperaba 1)`);
  }

  // ── CLEANUP ────────────────────────────────────────────────────────────────
  console.log('\n--- cleanup Fase A ---');
  for (const tid of createdTickets) { try { const t = await ax.get(`/tickets/${tid}`, { params: { fields: 'totals(due),open' } }); const due = Number(t.data?.totals?.due ?? 0); if (t.data?.open !== false && due > 0) await ax.post(`/tickets/${tid}/payments`, { type: '3rd_party', tender_type: cfg.defaultTenderId, amount: due, tip: 0, comment: 'A-cl' }, { headers: { 'Idempotency-Id': `Acl-${tid}` } }); } catch {} }
  for (const oid of createdOrders) { try { await c.query(`update orders set closed_at=now(), status='check-closed' where id=$1 and site_id=$2 and closed_at is null`, [oid, SITE]); } catch {} }
  for (const t of usedTables) { try { await c.query(`update floor_elements set status='available' where id=$1 and site_id=$2`, [t, SITE]); } catch {} }
  await c.query(`delete from idempotency_keys where key like $1`, [`${TOK}-%`]);
  console.log(`cerradas ${createdOrders.size} órdenes, ${createdTickets.size} tickets pagados, ${usedTables.size} mesas`);
  await c.end();

  console.log(`\n===== FASE A: ${pass.length} pass / ${fail.length} fail =====`);
  if (findings.length) console.log('HALLAZGOS:\n' + findings.map((f) => '  - ' + f).join('\n'));
})().catch((e) => { console.error('FATAL', e.response?.status, e.message, JSON.stringify(e.response?.data)); process.exit(1); });
