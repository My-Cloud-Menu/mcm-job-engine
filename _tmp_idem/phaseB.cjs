/**
 * AUDITORÍA BIDIRECCIONAL — Fase B (VOLUMEN / RUSH).
 * B1: abrir ~50 órdenes concurrentes (llaves únicas, 50 mesas) → 50 órdenes, métricas.
 * B2: tormenta doble-submit (cada llave 2× en paralelo = 100 calls) → sigue 50 (dedup bajo rush).
 * B3: fires concurrentes en un subconjunto.
 * B4: integridad post-carga (0 duplicados por ticket, dead_letters, cola, workers, conteo).
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');
const SITE = 55126712, TOK = Date.now().toString(36).slice(-5).toUpperCase();
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY, SUPA = process.env.SUPABASE_URL;
const N = 50, CONC = 8, FIRE_N = 15, PROD = 10002;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [], fail = [], findings = [], metrics = {};
const ok = (n, d) => { pass.push(n); console.log(`✅ ${n} — ${d}`); };
const no = (n, d) => { fail.push(n); findings.push(`[${n}] ${d}`); console.log(`❌ ${n} — ${d}`); };
const edge = async (slug, body, key) => {
  const t0 = Date.now();
  const r = await axios.post(`${SUPA}/functions/v1/${slug}`, { site_id: SITE, ...body, ...(key ? { idempotency_key: key } : {}) }, { headers: { Authorization: `Bearer ${SR}`, apikey: SR, 'Content-Type': 'application/json' }, validateStatus: () => true, timeout: 40000 }).catch((e) => ({ status: 0, data: { error: e.code || e.message } }));
  return { status: r.status, data: r.data, ms: Date.now() - t0 };
};
// pool de concurrencia
async function pmap(items, fn, conc) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }));
  return out;
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const cfg = (await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE])).rows[0].config;
  const ax = axios.create({ baseURL: `https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`, headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
  const tables = (await c.query(`select id from floor_elements where site_id=$1 and type='table' and status='available' order by random() limit $2`, [SITE, N + 5])).rows.map((r) => r.id);
  const keyOf = (i) => `${TOK}-vol-${i}`;
  const dlBefore = Number((await c.query(`select count(*) n from integration_jobs where status='dead_letter'`)).rows[0].n);
  const countKeys = async () => Number((await c.query(`select count(*) n from orders where site_id=$1 and additional_properties->>'idempotency_key' like $2`, [SITE, `${TOK}-vol-%`])).rows[0].n);

  console.log(`\n################ FASE B — VOLUMEN ${TOK} (N=${N}, conc=${CONC}) ################\n`);

  // ── B1: abrir N órdenes concurrentes ──
  console.log(`B1: abriendo ${N} órdenes (conc ${CONC})...`);
  const t0 = Date.now();
  const r1 = await pmap([...Array(N).keys()], async (i) => edge('open-table-order', { table_id: tables[i], guests: 1, employee: { id: '975', first_name: 'V' } }, keyOf(i)), CONC);
  const wall1 = Date.now() - t0;
  const okN = r1.filter((r) => r.status === 200 && r.data?.order?.id).length;
  const errs = r1.filter((r) => r.status !== 200);
  const lat = r1.map((r) => r.ms);
  metrics.B1 = { N, ok: okN, errors: errs.length, wall_s: (wall1 / 1000).toFixed(1), p50_ms: pct(lat, 50), p95_ms: pct(lat, 95), max_ms: Math.max(...lat) };
  const createdCount = await countKeys();
  console.log(`B1: ${okN}/${N} ok, ${errs.length} errores, wall ${(wall1/1000).toFixed(1)}s, p50=${pct(lat,50)}ms p95=${pct(lat,95)}ms max=${Math.max(...lat)}ms; órdenes en DB=${createdCount}`);
  if (errs.length) console.log('  errores:', JSON.stringify(errs.slice(0,5).map((e)=>({s:e.status,e:e.data?.error}))));
  if (okN === N && createdCount === N) ok('B1.bulkOpen', `${N} órdenes creadas sin duplicados`);
  else if (createdCount === okN && errs.length) no('B1.bulkOpen', `${okN}/${N} ok (${errs.length} fallaron en Aloha bajo carga); DB consistente (${createdCount}=${okN}, sin dup)`);
  else no('B1.bulkOpen', `okN=${okN} createdCount=${createdCount} (esperaba ${N}/${N})`);

  // ── B2: tormenta doble-submit (cada llave 2× en paralelo) ──
  console.log(`\nB2: tormenta doble-submit (${N}×2=${N*2} calls)...`);
  const pairs = [];
  for (let i = 0; i < N; i++) { pairs.push(['a', i]); pairs.push(['b', i]); }
  const t2 = Date.now();
  const r2 = await pmap(pairs, async ([, i]) => edge('open-table-order', { table_id: tables[i], guests: 1, employee: { id: '975', first_name: 'V' } }, keyOf(i)), CONC * 2);
  const wall2 = Date.now() - t2;
  const after2 = await countKeys();
  const s409 = r2.filter((r) => r.status === 409).length, s200 = r2.filter((r) => r.status === 200).length;
  metrics.B2 = { calls: N * 2, http200: s200, http409_inflight: s409, wall_s: (wall2 / 1000).toFixed(1), orders_after: after2 };
  console.log(`B2: ${s200}×200, ${s409}×409(in_flight); órdenes tras tormenta=${after2} (debe seguir ${createdCount})`);
  if (after2 === createdCount) ok('B2.retryStorm', `doble-submit ${N*2} calls → SIN órdenes nuevas (${after2}), dedup sólido bajo rush`);
  else no('B2.retryStorm', `órdenes ${createdCount}→${after2} (¡creó duplicados bajo carga!)`);

  // ── B3: fires concurrentes en subconjunto ──
  console.log(`\nB3: fires concurrentes en ${FIRE_N} órdenes...`);
  const ids = (await c.query(`select id, pos_id, omnivore_pos_id from orders where site_id=$1 and additional_properties->>'idempotency_key' like $2 and (pos_id is not null or omnivore_pos_id is not null) limit $3`, [SITE, `${TOK}-vol-%`, FIRE_N])).rows;
  const r3 = await pmap(ids, async (o) => {
    const ra = await edge('add-products-to-order', { order_id: o.id, line_items: [{ product_id: PROD, quantity: 1 }] }, `${TOK}-vadd-${o.id}`);
    const L = (ra.data?.order?.line_items ?? []).filter((x) => String(x.product_id) === String(PROD)).slice(-1)[0]?.id;
    if (!L) return { ok: false, reason: 'no-line' };
    const f = await edge('send-to-kitchen', { order_id: o.id, line_item_ids: [L], employee: { id: '975', first_name: 'V' } }, `${TOK}-vfire-${o.id}`);
    return { ok: f.status === 200, status: f.status, tid: o.pos_id || o.omnivore_pos_id, L };
  }, 6);
  const firedOk = r3.filter((r) => r.ok).length;
  metrics.B3 = { attempted: ids.length, fired_ok: firedOk };
  // verificar ítems en ticket de los fireados (muestra)
  let dupItems = 0;
  for (const r of r3.filter((x) => x.ok).slice(0, 8)) { try { const cnt = (await ax.get(`/tickets/${r.tid}`, { params: { fields: 'items(id)' } })).data?._embedded?.items?.length ?? 0; if (cnt > 1) dupItems++; } catch {} }
  console.log(`B3: ${firedOk}/${ids.length} fires OK; tickets muestreados con >1 ítem (posible dup): ${dupItems}`);
  if (firedOk >= Math.floor(ids.length * 0.8) && dupItems === 0) ok('B3.bulkFire', `${firedOk}/${ids.length} fires OK, sin duplicación de ítems`);
  else no('B3.bulkFire', `firedOk=${firedOk}/${ids.length} dupItems=${dupItems}`);

  // ── B4: integridad post-carga (esperar 1 ciclo de sync) ──
  console.log(`\nB4: esperando ciclo de sync (75s) para integridad...`);
  await sleep(75000);
  const finalCount = await countKeys();
  const dups = (await c.query(`select omnivore_pos_id, count(*) n from orders where site_id=$1 and additional_properties->>'idempotency_key' like $2 and omnivore_pos_id is not null group by omnivore_pos_id having count(*)>1`, [SITE, `${TOK}-vol-%`])).rows;
  const dlAfter = Number((await c.query(`select count(*) n from integration_jobs where status='dead_letter'`)).rows[0].n);
  const qDepth = Number((await c.query(`select count(*) n from integration_jobs where status in ('pending','retrying','running')`)).rows[0].n);
  metrics.B4 = { orders_final: finalCount, dup_tickets: dups.length, dead_letter_delta: dlAfter - dlBefore, queue_depth: qDepth };
  console.log(`B4: órdenes finales=${finalCount}, duplicados por ticket=${dups.length}, Δdead_letter=${dlAfter - dlBefore}, cola=${qDepth}`);
  if (dups.length === 0 && (dlAfter - dlBefore) === 0) ok('B4.integrity', `tras sync: 0 duplicados por ticket, 0 nuevos dead_letters, cola=${qDepth} (estable bajo volumen)`);
  else no('B4.integrity', `dups=${dups.length} Δdeadletter=${dlAfter - dlBefore}`);

  // ── CLEANUP ──
  console.log('\n--- cleanup volumen ---');
  const allOrders = (await c.query(`select id, pos_id, omnivore_pos_id from orders where site_id=$1 and additional_properties->>'idempotency_key' like $2`, [SITE, `${TOK}-vol-%`])).rows;
  // pagar tickets (conc)
  await pmap(allOrders, async (o) => { const tid = o.omnivore_pos_id || o.pos_id; if (!tid) return; try { const t = await ax.get(`/tickets/${tid}`, { params: { fields: 'totals(due),open' } }); const due = Number(t.data?.totals?.due ?? 0); if (t.data?.open !== false && due > 0) await ax.post(`/tickets/${tid}/payments`, { type: '3rd_party', tender_type: cfg.defaultTenderId, amount: due, tip: 0, comment: 'Bcl' }, { headers: { 'Idempotency-Id': `Bcl-${tid}` } }); } catch {} }, 8);
  await c.query(`update orders set closed_at=now(), status='check-closed' where site_id=$1 and additional_properties->>'idempotency_key' like $2 and closed_at is null`, [SITE, `${TOK}-vol-%`]);
  await c.query(`update floor_elements set status='available' where id = any($1) and site_id=$2`, [tables, SITE]);
  await c.query(`delete from idempotency_keys where key like $1`, [`${TOK}-%`]);
  console.log(`cerradas ${allOrders.length} órdenes, mesas liberadas, tickets pagados`);
  await c.end();

  console.log(`\n===== FASE B: ${pass.length} pass / ${fail.length} fail =====`);
  console.log('MÉTRICAS:', JSON.stringify(metrics, null, 2));
  if (findings.length) console.log('HALLAZGOS:\n' + findings.map((f) => '  - ' + f).join('\n'));
  // persistir métricas para el reporte
  require('fs').writeFileSync(__dirname + '/phaseB_metrics.json', JSON.stringify({ pass, fail, metrics, findings }, null, 2));
})().catch((e) => { console.error('FATAL', e.response?.status, e.message, JSON.stringify(e.response?.data)); process.exit(1); });
