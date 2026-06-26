/**
 * E2E del dedup SIN integración Omnivore. Deshabilita temporalmente el table-service de
 * Carlos Business (restore garantizado en finally) → los edges toman el path NO-managed
 * (skip Omnivore). Verifica que el dedup (claim MCM-side) funciona igual y que NO se crea
 * ticket en Omnivore (pos_id queda null, omnivore_managed != true).
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

const T = { open: '0', conc: '0', stale: '0' }; // se llenan abajo con mesas reales
const PROD = 10002;

const edge = async (slug, body, idempotency_key) => {
  const r = await axios.post(`${SUPA}/functions/v1/${slug}`,
    { site_id: SITE, ...body, ...(idempotency_key ? { idempotency_key } : {}) },
    { headers: { Authorization: `Bearer ${SR}`, apikey: SR, 'Content-Type': 'application/json' }, validateStatus: () => true });
  return r;
};

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // mesas disponibles para el test
  const tbls = (await c.query(`select id from floor_elements where site_id=$1 and type='table' and status='available' order by table_number limit 3`, [SITE])).rows;
  T.open = tbls[0].id; T.conc = tbls[1].id; T.stale = tbls[2].id;

  // snapshot del config original (para restaurar SIEMPRE)
  const { rows: cfgRows } = await c.query(`select id, config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE]);
  const integId = cfgRows[0].id;
  const originalConfig = cfgRows[0].config;
  const createdOrders = new Set(), usedTables = new Set([T.open, T.conc, T.stale]), idemKeys = [];
  const orderRow = async (id) => (await c.query(`select id, pos_id, omnivore_pos_id, additional_properties, line_items, status from orders where id=$1 and site_id=$2`, [id, SITE])).rows[0];
  const countByKey = async (k) => Number((await c.query(`select count(*) n from orders where site_id=$1 and additional_properties->>'idempotency_key'=$2`, [SITE, k])).rows[0].n);

  console.log(`\n############ NO-INTEGRATION E2E ${TOK} ############`);

  try {
    // ── deshabilitar table-service (path no-managed) ──
    const offConfig = { ...originalConfig, omnivoreTableServiceEnabled: false };
    await c.query(`update site_integrations set config=$1 where id=$2`, [offConfig, integId]);
    console.log('table-service DESHABILITADO temporalmente (omnivoreTableServiceEnabled=false)\n');
    await sleep(500);

    // ── 1: open-table dedup sin integración ──
    {
      const K = `${TOK}-niOpen`; idemKeys.push(K);
      const r1 = await edge('open-table-order', { table_id: T.open, guests: 1, employee: { id: '975', first_name: 'NI' } }, K);
      await sleep(1200);
      const r2 = await edge('open-table-order', { table_id: T.open, guests: 1, employee: { id: '975', first_name: 'NI' } }, K);
      const id1 = r1.data?.order?.id, id2 = r2.data?.order?.id;
      if (id1) createdOrders.add(id1); if (id2) createdOrders.add(id2);
      const n = await countByKey(K);
      const row = id1 ? await orderRow(id1) : null;
      const notManaged = row && row.additional_properties?.omnivore_managed !== true && !row.pos_id;
      if (r1.status === 200 && id2 === id1 && n === 1 && notManaged)
        ok('noint.openTable.dedup', `misma llave → 1 orden ${id1}; NO managed, pos_id null (Omnivore saltado) ✓`);
      else no('noint.openTable.dedup', `r1=${r1.status} id1=${id1} id2=${id2} n=${n} pos_id=${row?.pos_id} managed=${row?.additional_properties?.omnivore_managed}`);
    }

    // ── 2: open-tab dedup sin integración ──
    {
      const K = `${TOK}-niTab`; idemKeys.push(K);
      const name = `NI${TOK}`.slice(0, 14);
      const r1 = await edge('open-tab', { experience_reference: name, employee: { id: '975', first_name: 'NI' } }, K);
      await sleep(1200);
      const r2 = await edge('open-tab', { experience_reference: name, employee: { id: '975', first_name: 'NI' } }, K);
      const id1 = r1.data?.order?.id, id2 = r2.data?.order?.id;
      if (id1) createdOrders.add(id1); if (id2) createdOrders.add(id2);
      const n = await countByKey(K);
      const row = id1 ? await orderRow(id1) : null;
      if (r1.status === 200 && id2 === id1 && n === 1 && row && !row.pos_id)
        ok('noint.openTab.dedup', `misma llave → 1 tab ${id1}; pos_id null (sin ticket Omnivore) ✓`);
      else no('noint.openTab.dedup', `r1=${r1.status} id1=${id1} id2=${id2} n=${n} pos_id=${row?.pos_id}`);
    }

    // ── 3: fire dedup sin integración (solo marca sent, no toca Omnivore) ──
    {
      const ro = await edge('open-table-order', { table_id: T.conc, guests: 1, employee: { id: '975', first_name: 'NI' } }, `${TOK}-niFireOpen`);
      idemKeys.push(`${TOK}-niFireOpen`); const oid = ro.data?.order?.id; if (oid) createdOrders.add(oid);
      const ra = await edge('add-products-to-order', { order_id: oid, line_items: [{ product_id: PROD, quantity: 1 }] }, `${TOK}-niFireAdd`);
      const lines = ra.data?.order?.line_items ?? [];
      const L = lines.find((x) => String(x.product_id) === String(PROD))?.id ?? lines[lines.length - 1]?.id;
      const Kf = `${TOK}-niFire`;
      const f1 = await edge('send-to-kitchen', { order_id: oid, line_item_ids: [L], employee: { id: '975', first_name: 'NI' } }, Kf);
      await sleep(800);
      const f2 = await edge('send-to-kitchen', { order_id: oid, line_item_ids: [L], employee: { id: '975', first_name: 'NI' } }, Kf);
      const row = await orderRow(oid);
      const line = (row?.line_items ?? []).find((x) => x.id === L);
      const sentNoOmni = line?.status === 'sent' && !line?.additional_properties?.omnivore?.item_id && !row?.pos_id;
      if (f1.status === 200 && f2.status === 200 && sentNoOmni)
        ok('noint.fire.dedup', `fire ×2 misma llave → línea 'sent', SIN item_id Omnivore, sin ticket (f1=${f1.status} f2=${f2.status}) ✓`);
      else no('noint.fire.dedup', `f1=${f1.status} f2=${f2.status} status=${line?.status} oid_pos=${row?.pos_id} omni=${JSON.stringify(line?.additional_properties?.omnivore)}`);

      // void dedup sin integración (línea sent local; sin omnivore item → sin pin de manager? sent requiere pin)
      // usamos una 2ª línea SIN firear para no requerir pin
      const ra2 = await edge('add-products-to-order', { order_id: oid, line_items: [{ product_id: PROD, quantity: 1 }] }, `${TOK}-niVoidAdd`);
      const lines2 = ra2.data?.order?.line_items ?? [];
      const V = lines2.filter((x) => String(x.product_id) === String(PROD) && x.status !== 'sent' && x.status !== 'voided').slice(-1)[0]?.id;
      if (V) {
        const Kv = `${TOK}-niVoid`;
        const v1 = await edge('void-line-item', { order_id: oid, line_item_id: V, reason: 'ni', employee: { id: '975', first_name: 'NI' } }, Kv);
        await sleep(600);
        const v2 = await edge('void-line-item', { order_id: oid, line_item_id: V, reason: 'ni', employee: { id: '975', first_name: 'NI' } }, Kv);
        const after = await orderRow(oid);
        const vs = (after?.line_items ?? []).find((x) => x.id === V)?.status;
        if (v1.status === 200 && v2.status === 200 && vs === 'voided')
          ok('noint.void.dedup', `void ×2 misma llave → 'voided', ambos ok (v1=${v1.status} v2=${v2.status}) ✓`);
        else no('noint.void.dedup', `v1=${v1.status} v2=${v2.status} vs=${vs} ${JSON.stringify(v1.data).slice(0,120)}`);
      } else no('noint.void.dedup', `no se encontró línea sin firear para void (V=${V})`);
    }

    // ── 4: concurrencia sin integración ──
    {
      const K = `${TOK}-niConc`; idemKeys.push(K);
      const body = { table_id: T.stale, guests: 1, employee: { id: '975', first_name: 'NI' } };
      const [a, b] = await Promise.all([edge('open-table-order', body, K), edge('open-table-order', body, K)]);
      await sleep(1000);
      if (a.data?.order?.id) createdOrders.add(a.data.order.id); if (b.data?.order?.id) createdOrders.add(b.data.order.id);
      const n = await countByKey(K);
      if (n === 1) ok('noint.concurrency', `paralelo misma llave → 1 orden (statuses ${[a.status, b.status].sort().join(',')}) ✓`);
      else no('noint.concurrency', `n=${n}`);
    }

  } finally {
    // ── RESTORE garantizado ──
    await c.query(`update site_integrations set config=$1 where id=$2`, [originalConfig, integId]);
    const { rows: chk } = await c.query(`select config->>'omnivoreTableServiceEnabled' as ts from site_integrations where id=$1`, [integId]);
    console.log(`\ntable-service RESTAURADO → omnivoreTableServiceEnabled=${chk[0].ts}`);
    // cleanup órdenes + mesas + llaves
    for (const oid of createdOrders) { try { await c.query(`delete from orders where id=$1 and site_id=$2`, [oid, SITE]); } catch {} }
    for (const tbl of usedTables) { try { await c.query(`update floor_elements set status='available' where id=$1 and site_id=$2`, [tbl, SITE]); } catch {} }
    await c.query(`delete from idempotency_keys where key like $1`, [`${TOK}-%`]);
    console.log(`cleaned: ${createdOrders.size} orders, ${usedTables.size} tables freed`);
    await c.end();
  }

  console.log(`\n===== NO-INTEGRATION RESULT: ${pass.length} pass / ${fail.length} fail =====`);
  if (fail.length) { console.log('FAILS:', fail.join(', ')); process.exit(1); }
})().catch((e) => { console.error('FATAL', e.response?.status, e.message, JSON.stringify(e.response?.data)); process.exit(1); });
