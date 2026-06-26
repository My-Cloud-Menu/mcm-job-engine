/** Librería compartida para los harnesses de inyección Omnivore (online/kiosk). */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');

const SITE = 55126712;
const MENU = '300015', PROD = 10002;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; }
async function getCfg(c) { return (await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE])).rows[0].config; }
function omniClient(cfg) { return axios.create({ baseURL: `https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`, headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true }); }

// crea una orden online NO-managed mínima pero válida.
// IMPORTANTE: `orders` tiene un BEFORE INSERT trigger (`trigger_generate_id`) que ASIGNA el id
// desde la tabla `ids`; por eso insertamos SIN id y leemos el real con RETURNING.
// El site Carlos Business tiene `sendOrderToOmnivoreInStatusChange=false` → insertar una orden
// 'new-order' NO dispara auto-inyección (verificado), así que el enqueue manual es la única.
async function createOnlineOrder(c, { total = 6.49, status = 'new-order' } = {}) {
  const now = new Date().toISOString();
  const { rows } = await c.query(
    `insert into orders (site_id, check_number, channel, status, experience, currency, total, subtotal, paid, line_items, fee_lines, tax_lines, customer, employee, date_created, date_updated, opened_at)
     values ($1,1,'online',$2,'pu','USD',$3,$3,0,'[]','[]','[]',$4,'{}',$5,$5,$5) returning id`,
    [SITE, status, total, JSON.stringify({ first_name: 'Online Test', phone: '' }), now]
  );
  const id = Number(rows[0].id);
  const lineId = `li-${id}-1`;
  const lineItems = [{ id: lineId, product_id: PROD, quantity: 1, name: 'Chips & Salsa', price: 6, total: 6, status: 'new' }];
  await c.query(`update orders set line_items=$1 where id=$2 and site_id=$3`, [JSON.stringify(lineItems), id, SITE]);
  return { id, lineId, lineItems };
}

// enquela una inyección de 3 pasos (como el edge), payments opcional
async function enqueueInjection(c, cfg, orderId, { withPayment = true, amountCents = 0, idemSuffix = '' } = {}) {
  const idemKey = `pos_inject:omnivore:${orderId}` + (idemSuffix ? `:${idemSuffix}` : '');
  const ticket = { employee: cfg.defaultEmployeeId, order_type: cfg.defaultOrderTypeId, revenue_center: cfg.defaultRevenueCenterId, name: `MCM ${orderId}`.slice(0, 15), auto_send: false };
  const items = [{ menu_item: MENU, quantity: 1, item_order_mode: cfg.defaultOrderTypeId, auto_send: true }];
  const payments = withPayment ? [{ type: '3rd_party', tender_type: cfg.defaultTenderId, amount: amountCents, tip: 0, comment: `inj-test ${orderId}` }] : [];
  const { rows } = await c.query(
    `select enqueue_job($1,'pos_injection','order_injection','omnivore',$2,$3::jsonb,3,$4::jsonb,7,now(),'order',$5,null) as job_id`,
    [SITE, idemKey, JSON.stringify({ order_id: orderId, ticket, items, payments }),
     JSON.stringify([
       { step_name: 'create_order', max_attempts: 3, idempotency_key: `${idemKey}:create_order` },
       { step_name: 'add_items', max_attempts: 5, idempotency_key: `${idemKey}:add_items` },
       { step_name: 'create_payment', max_attempts: 5, idempotency_key: `${idemKey}:create_payment` },
     ]),
     String(orderId)]
  );
  return { jobId: rows[0].job_id, idemKey };
}

async function jobRow(c, jobId) { return (await c.query(`select id, status, current_step_name, last_error, context from integration_jobs where id=$1`, [jobId])).rows[0]; }
async function waitJob(c, jobId, statuses = ['completed', 'dead_letter'], ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const j = await jobRow(c, jobId); if (j && statuses.includes(j.status)) return j; await sleep(1500); }
  return await jobRow(c, jobId);
}
async function orderRow(c, id) { return (await c.query(`select id, pos_id, omnivore_pos_id, paid, line_items, status from orders where id=$1 and site_id=$2`, [id, SITE])).rows[0]; }
async function ticketItems(ax, tid) { const r = await ax.get(`/tickets/${tid}`, { params: { fields: 'items(id)' } }); return (r.data?._embedded?.items ?? []).length; }
async function ticketTotals(ax, tid) { const r = await ax.get(`/tickets/${tid}`, { params: { fields: 'totals(due,paid),open,payments(id)' } }); return { due: Number(r.data?.totals?.due ?? 0), paid: Number(r.data?.totals?.paid ?? 0), open: r.data?.open, pays: (r.data?._embedded?.payments ?? []).length }; }
async function openTicketsByName(ax, name) { // scan (Aloha-safe): listar abiertos y filtrar en memoria
  const r = await ax.get('/tickets', { params: { where: 'eq(open,true)', fields: 'id,name', limit: 200 } });
  return (r.data?._embedded?.tickets ?? []).filter((t) => String(t.name ?? '') === name).map((t) => String(t.id));
}

// due real de 1× Chips&Salsa (para construir pagos que matcheen)
async function probeDue(ax, cfg) {
  const tk = await ax.post('/tickets', { employee: cfg.defaultEmployeeId, order_type: cfg.defaultOrderTypeId, revenue_center: cfg.defaultRevenueCenterId, name: `DUE${Date.now().toString(36).slice(-5)}`.slice(0, 15), auto_send: false });
  const tid = tk.data?.id;
  await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: MENU, quantity: 1, item_order_mode: cfg.defaultOrderTypeId, auto_send: false }] }, { headers: { 'Idempotency-Id': `due-${tid}` } });
  await sleep(1500);
  const t = await ticketTotals(ax, tid);
  // cerrar el probe
  if (t.due > 0) await ax.post(`/tickets/${tid}/payments`, { type: '3rd_party', tender_type: cfg.defaultTenderId, amount: t.due, tip: 0, comment: 'due-probe' }, { headers: { 'Idempotency-Id': `duepay-${tid}` } });
  return { due: t.due, ticketId: tid };
}

// cleanup de una orden: cerrar ticket (pagar saldo) + cerrar orden + purgar jobs/idem
async function cleanupOrder(c, ax, cfg, orderId) {
  const o = await orderRow(c, orderId);
  const tid = o?.omnivore_pos_id || o?.pos_id;
  if (tid) { try { const t = await ticketTotals(ax, tid); if (t.open !== false && t.due > 0) await ax.post(`/tickets/${tid}/payments`, { type: '3rd_party', tender_type: cfg.defaultTenderId, amount: t.due, tip: 0, comment: 'cl' }, { headers: { 'Idempotency-Id': `injcl-${tid}` } }); } catch {} }
  await c.query(`delete from orders where id=$1 and site_id=$2`, [orderId, SITE]);
  await c.query(`delete from integration_jobs where reference_id=$1 and site_id=$2 and job_type='order_injection'`, [String(orderId), SITE]);
  await c.query(`delete from idempotency_keys where key like $1`, [`pos_inject:omnivore:${orderId}%`]);
}

module.exports = { SITE, MENU, PROD, sleep, connect, getCfg, omniClient, createOnlineOrder, enqueueInjection, jobRow, waitJob, orderRow, ticketItems, ticketTotals, openTicketsByName, probeDue, cleanupOrder };
