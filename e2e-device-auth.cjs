/* Verifica que la SESIÓN DE DEVICE (user_sites role='device'), NO service_role, pase el
 * siteAccessGuard de las mutaciones POS. Mintea el JWT del device vía admin generateLink →
 * verifyOtp (sin tocar su password). Tokens NUNCA se imprimen. */
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');

const je = Object.fromEntries(fs.readFileSync(__dirname + '/.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const edge = Object.fromEntries(fs.readFileSync(__dirname + '/../mcm-edge-functions/supabase/functions/.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));

const URL = je.SUPABASE_URL;
const SERVICE = je.SUPABASE_SERVICE_ROLE_KEY;
const ANON = edge.LOCAL_ANON_KEY;
const SITE = 55126712;
const DEVICE_EMAIL = 'op-device-op-938875e1@orderandpay-devices.mcm.app';

const jwtPayload = (t) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()); } catch { return {}; } };

async function callOpen(bearer, table_id) {
  const res = await fetch(`${URL}/functions/v1/open-table-order`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${bearer}`, 'apikey': ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: SITE, table_id, guests: 2, employee: { id: '9999', first_name: 'AuthTest' } }),
  });
  let j; try { j = await res.json(); } catch { j = null; }
  return { status: res.status, body: j };
}

(async () => {
  // tabla rc-20 disponible
  const c = new Client({ connectionString: je.DATABASE_URL }); await c.connect();
  const t = await c.query("select id, table_number from floor_elements where site_id=$1 and type='table' and revenue_center_id='20' and status='available' order by (table_number)::int limit 1", [SITE]);
  await c.end();
  const table = t.rows[0];
  console.log('tabla de prueba:', table?.table_number, '(' + String(table?.id).slice(0, 8) + ')');

  // 1) mint device JWT
  const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: DEVICE_EMAIL });
  if (linkErr) return console.error('generateLink ERROR:', linkErr.message);
  const hashed = link?.properties?.hashed_token;
  console.log('generateLink:', hashed ? 'ok' : 'sin hashed_token');

  const anonCli = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: sess, error: otpErr } = await anonCli.auth.verifyOtp({ token_hash: hashed, type: 'magiclink' });
  if (otpErr) return console.error('verifyOtp ERROR:', otpErr.message);
  const deviceJwt = sess?.session?.access_token;
  if (!deviceJwt) return console.error('verifyOtp: sin access_token');
  const p = jwtPayload(deviceJwt);
  console.log('device JWT minteado → role:', p.role, '| sub:', String(p.sub).slice(0, 8), '| (uid device esperado: 0e2bbf03)');

  // 2) POSITIVO: open-table-order con la sesión del DEVICE → debe pasar el guard
  const pos = await callOpen(deviceJwt, table.id);
  const guardPassed = pos.status !== 403;
  console.log('\n[DEVICE session] open-table-order status:', pos.status, '→ guard', guardPassed ? 'PASÓ ✓' : 'DENEGÓ ✗',
    pos.body?.order ? `(order ${pos.body.order.id}, pos_id ${pos.body.order.pos_id})` : (pos.body?.error ? `(${pos.body.error}${pos.body.slug ? '/' + pos.body.slug : ''})` : ''));

  // 3) NEGATIVO control: solo anon key (sin sesión de usuario) → debe DENEGAR (403)
  const neg = await callOpen(ANON, table.id);
  console.log('[ANON only ] open-table-order status:', neg.status, '→', neg.status === 403 ? 'DENEGADO ✓ (esperado)' : `INESPERADO: ${JSON.stringify(neg.body).slice(0, 120)}`);

  // 4) orderAccessGuard (consulta `orders` bajo RLS, distinto de `sites`): add + fire con el device
  let orderGuardOk = null;
  if (pos.body?.order?.id) {
    const oid = pos.body.order.id;
    const callEdge = async (slug, body) => {
      const r = await fetch(`${URL}/functions/v1/${slug}`, { method: 'POST', headers: { 'Authorization': `Bearer ${deviceJwt}`, 'apikey': ANON, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let j; try { j = await r.json(); } catch { j = null; } return { status: r.status, body: j };
    };
    const add = await callEdge('add-products-to-order', { order_id: String(oid), site_id: String(SITE), line_items: [{ product_id: 10002, quantity: 1 }] });
    const liId = add.body?.order?.line_items?.find?.((x) => x.name === 'Chips & Salsa')?.id;
    console.log('\n[DEVICE session] add-products-to-order status:', add.status, add.status !== 403 ? '→ orderAccessGuard PASÓ ✓' : '✗ DENEGÓ', liId ? `(item ${liId})` : '');
    let fire = { status: 'skip' };
    if (liId) fire = await callEdge('send-to-kitchen', { order_id: Number(oid), site_id: SITE, line_item_ids: [liId], employee: { id: '9999', first_name: 'AuthTest' } });
    console.log('[DEVICE session] send-to-kitchen status:', fire.status, fire.status !== 403 ? '→ orderAccessGuard PASÓ ✓' : '✗ DENEGÓ');
    orderGuardOk = add.status !== 403 && fire.status !== 403;
  }

  console.log('\nVEREDICTO:', (guardPassed && neg.status === 403 && orderGuardOk !== false)
    ? 'Device pasa siteAccessGuard + orderAccessGuard; anónimo rechazado ✓✓' : 'REVISAR ⚠');
  if (pos.body?.order?.id) console.log('(orden de prueba creada:', pos.body.order.id, '— junk de Dev)');
})().catch(e => console.error('ERR', e.message));
