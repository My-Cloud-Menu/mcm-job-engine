/* E2E harness — Omnivore Order&Pay table service (Dev / Carlos Business 55126712).
 * Secrets (service_role, apiKey, PINs) are read into vars and NEVER printed.
 * Usage: node e2e-omni.cjs <cmd> [args]
 *   setup                         -> sanity: env, omnivore creds, manager presence
 *   open <tableId>                -> open-table-order (blocking Omnivore ticket)
 *   add  <orderId> <prodId> <qty> [notes]
 *   fire <orderId> <id[,id...]>   -> send-to-kitchen
 *   void <orderId> <lineItemId>   -> void-line-item (auto manager PIN if item sent)
 *   hold <orderId> <lineItemId> <true|false>
 *   order <orderId>               -> DB dump of the MCM order
 *   omni <ticketId>               -> Omnivore ticket items + totals
 */
const fs = require('fs');
const { Client } = require('pg');

const SITE = 55126712;
const envPath = __dirname + '/.env';
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; })
);
const URL = env.SUPABASE_URL;
const SR = env.SUPABASE_SERVICE_ROLE_KEY;

async function db() { const c = new Client({ connectionString: env.DATABASE_URL }); await c.connect(); return c; }

async function omniCreds(c) {
  const r = await c.query("select config->>'apiKey' k, config->>'omnivoreId' o from site_integrations where site_id=$1 and provider='omnivore' and type='pos'", [SITE]);
  return { apiKey: r.rows[0].k, omnivoreId: r.rows[0].o };
}

async function callEdge(slug, body) {
  const res = await fetch(`${URL}/functions/v1/${slug}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SR}`, 'apikey': SR, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

const liSummary = (li) => (li || []).map(i => ({
  id: i.id, name: i.name, qty: i.quantity, status: i.status,
  total: i.total, omni: i.additional_properties?.omnivore,
}));

async function cmdSetup() {
  const c = await db();
  const cr = await omniCreds(c);
  const mgr = await c.query("select count(*) n from employees where site_id=$1 and role in ('manager','admin')", [SITE]);
  console.log('SUPABASE_URL host:', new global.URL(URL).host);
  console.log('service_role present:', !!SR);
  console.log('omnivoreId:', cr.omnivoreId);
  console.log('managers/admins available:', mgr.rows[0].n);
  await c.end();
}

async function cmdOpen(tableId) {
  const r = await callEdge('open-table-order', {
    site_id: SITE, table_id: tableId, guests: 2,
    employee: { id: '9999', first_name: 'E2E', last_name: 'Tester' },
  });
  console.log('open-table-order status:', r.status);
  if (r.json?.order) {
    const o = r.json.order;
    console.log('order_id:', o.id, '| pos_id:', o.pos_id, '| managed:', o.additional_properties?.omnivore_managed, '| synced_at:', o.additional_properties?.omnivore_synced_at);
  }
  if (r.json?.pos_warning) console.log('pos_warning:', r.json.pos_warning);
  if (r.json?.error) console.log('ERROR:', JSON.stringify(r.json));
}

async function cmdAdd(orderId, prodId, qty, notes) {
  const r = await callEdge('add-products-to-order', {
    order_id: String(orderId), site_id: String(SITE),
    line_items: [{ product_id: Number(prodId), quantity: Number(qty), notes: notes || '' }],
  });
  console.log('add status:', r.status);
  if (r.json?.order) console.log('total:', r.json.order.total, '| items:', JSON.stringify(liSummary(r.json.order.line_items), null, 0));
  if (r.json?.error) console.log('ERROR:', JSON.stringify(r.json));
}

async function cmdFire(orderId, idsCsv) {
  const ids = idsCsv.split(',');
  const r = await callEdge('send-to-kitchen', {
    order_id: Number(orderId), site_id: SITE, line_item_ids: ids,
    employee: { id: '9999', first_name: 'E2E' },
  });
  console.log('fire status:', r.status);
  if (r.json?.order) console.log('status:', r.json.order.status, '| total:', r.json.order.total, '| subtotal:', r.json.order.subtotal, '\nitems:', JSON.stringify(liSummary(r.json.order.line_items), null, 0));
  if (r.json?.error || r.json?.friendly_error) console.log('ERR/friendly:', JSON.stringify(r.json));
}

async function cmdVoid(orderId, lineItemId) {
  // find the item; if sent, fetch a manager PIN (never printed)
  const c = await db();
  const o = await c.query('select line_items from orders where id=$1 and site_id=$2', [orderId, SITE]);
  const li = (o.rows[0]?.line_items || []).find(x => x.id === lineItemId);
  let managerPin;
  if (li?.status === 'sent') {
    const m = await c.query("select login from employees where site_id=$1 and role in ('manager','admin') and login is not null limit 1", [SITE]);
    managerPin = m.rows[0]?.login;
  }
  await c.end();
  const r = await callEdge('void-line-item', {
    order_id: Number(orderId), site_id: SITE, line_item_id: lineItemId,
    reason: 'E2E test void', employee: { id: '9999', first_name: 'E2E' },
    ...(managerPin ? { manager_pin: managerPin } : {}),
  });
  console.log('void status:', r.status, managerPin ? '(manager PIN sent)' : '(no PIN — item not sent)');
  if (r.json?.order) console.log('total:', r.json.order.total, '| subtotal:', r.json.order.subtotal, '\nitems:', JSON.stringify(liSummary(r.json.order.line_items), null, 0));
  if (r.json?.warning || r.json?.friendly_error) console.log('warning/friendly:', JSON.stringify({ warning: r.json.warning, friendly_error: r.json.friendly_error }));
  if (r.json?.error) console.log('ERROR:', JSON.stringify(r.json));
}

async function cmdHold(orderId, lineItemId, hold) {
  const r = await callEdge('set-line-item-hold', {
    order_id: Number(orderId), site_id: SITE, line_item_id: lineItemId,
    held: hold === 'true', employee: { id: '9999', first_name: 'E2E' },
  });
  console.log('hold status:', r.status, '->', JSON.stringify(r.json).slice(0, 300));
}

async function cmdUpdate(orderId, lineItemId, qty, notes) {
  const r = await callEdge('update-line-item', {
    order_id: Number(orderId), site_id: SITE, line_item_id: lineItemId,
    line_item: { quantity: Number(qty), notes: notes || '' },
    employee: { id: '9999', first_name: 'E2E' },
  });
  console.log('update status:', r.status);
  if (r.json?.order) console.log('total:', r.json.order.total, '| items:', JSON.stringify(liSummary(r.json.order.line_items)));
  if (r.json?.error) console.log('ERROR:', JSON.stringify(r.json));
}

async function cmdCancel(orderId) {
  // cancel needs manager role OR pin; fetch a manager login for caller employee.id
  const c = await db();
  const m = await c.query("select id, login from employees where site_id=$1 and role in ('manager','admin') limit 1", [SITE]);
  await c.end();
  const mgr = m.rows[0];
  const r = await callEdge('cancel-order', {
    order_id: Number(orderId), site_id: SITE, reason: 'E2E test cancel',
    employee: { id: String(mgr?.id ?? '9999'), first_name: 'Mgr' },
    ...(mgr?.login ? { manager_pin: mgr.login } : {}),
  });
  console.log('cancel status:', r.status, '->', JSON.stringify({ pos_warning: r.json?.pos_warning, error: r.json?.error, ok: r.json?.ok }));
}

async function cmdOrder(orderId) {
  const c = await db();
  const r = await c.query('select id, status, total, subtotal, total_tax, paid, pos_id, payment_status, additional_properties, line_items, date_updated from orders where id=$1 and site_id=$2', [orderId, SITE]);
  await c.end();
  const o = r.rows[0];
  if (!o) return console.log('order not found');
  console.log(JSON.stringify({
    id: o.id, status: o.status, total: o.total, subtotal: o.subtotal, total_tax: o.total_tax, paid: o.paid,
    pos_id: o.pos_id, payment_status: o.payment_status,
    managed: o.additional_properties?.omnivore_managed, synced_at: o.additional_properties?.omnivore_synced_at,
    date_updated: o.date_updated,
    items: liSummary(o.line_items),
  }, null, 1));
}

async function cmdOmni(ticketId) {
  const c = await db(); const cr = await omniCreds(c); await c.end();
  const base = `https://api.omnivore.io/1.0/locations/${cr.omnivoreId}`;
  const H = { headers: { 'Api-Key': cr.apiKey } };
  const g = await fetch(`${base}/tickets/${ticketId}?fields=open,totals,items`, H);
  console.log('omni GET status:', g.status);
  const j = await g.json();
  const items = (j._embedded?.items || []).map(i => ({ id: i.id, name: i.name, qty: i.quantity, price: i.price, sent: i.sent, menu_item: i._embedded?.menu_item?.id }));
  console.log('open:', j.open, '| totals:', JSON.stringify(j.totals));
  console.log('items:', JSON.stringify(items, null, 1));
}

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  try {
    if (cmd === 'setup') await cmdSetup();
    else if (cmd === 'open') await cmdOpen(a[0]);
    else if (cmd === 'add') await cmdAdd(a[0], a[1], a[2], a[3]);
    else if (cmd === 'fire') await cmdFire(a[0], a[1]);
    else if (cmd === 'void') await cmdVoid(a[0], a[1]);
    else if (cmd === 'hold') await cmdHold(a[0], a[1], a[2]);
    else if (cmd === 'update') await cmdUpdate(a[0], a[1], a[2], a[3]);
    else if (cmd === 'cancel') await cmdCancel(a[0]);
    else if (cmd === 'order') await cmdOrder(a[0]);
    else if (cmd === 'omni') await cmdOmni(a[0]);
    else console.log('unknown cmd:', cmd);
  } catch (e) { console.error('HARNESS ERR:', e.message); }
})();
