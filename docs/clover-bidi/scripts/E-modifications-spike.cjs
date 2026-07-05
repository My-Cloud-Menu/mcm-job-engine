/* Slice E spike — is Clover native line-item /modifications feasible + idempotent (P1.6)?
 * Creates one order, adds a line item, attaches a catalog modifier, then re-attaches the SAME
 * modifier to observe whether Clover dedups (it does NOT) → informs the MCM-side idempotency
 * requirement before any production wiring. Cleans up. Never prints secrets.
 */
const fs = require('fs');
const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const env = Object.fromEntries(fs.readFileSync(SCRATCH + '/clover-sandbox.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const BASE = env.CLOVER_SANDBOX_API_BASE_URL, MID = env.CLOVER_SANDBOX_MERCHANT_ID, TOK = env.CLOVER_SANDBOX_API_TOKEN;
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', 'User-Agent': 'MyCloudMenu-JobEngine/1.0-clover-bidi' };
const cget = async (p) => (await (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { headers: H })).json().catch(() => ({})));
const cpost = async (p, b) => { const r = await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const cdel = async (p) => (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'DELETE', headers: H })).status;

(async () => {
  const out = {};
  // 1. find an item that has a modifier group + a modifier
  const items = (await cget('/items?limit=100&expand=modifierGroups')).elements || [];
  const withMods = items.find((i) => (i.modifierGroups?.elements || []).length > 0 && i.price > 0);
  const mg = (await cget('/modifier_groups?limit=50&expand=modifiers')).elements || [];
  const group = mg.find((g) => (g.modifiers?.elements || []).length > 0);
  const modifier = group?.modifiers?.elements?.[0];
  out.picked = { item: withMods && { id: withMods.id, name: withMods.name }, modifier: modifier && { id: modifier.id, name: modifier.name, price: modifier.price } };
  if (!withMods || !modifier) { console.log(JSON.stringify({ error: 'no item/modifier found', out }, null, 2)); process.exit(0); }

  // 2. create order + a line item referencing the item
  const ord = (await cpost('/orders', { orderType: { id: 'E409NQ4X4RQ0T' }, note: 'E spike', clientCreatedTime: Date.now() })).j;
  const li = await cpost(`/orders/${ord.id}/line_items`, { item: { id: withMods.id } });
  out.line_item_create_status = li.status;
  const lineItemId = li.j?.id;
  out.line_item_id = lineItemId;

  if (lineItemId) {
    // 3. attach the modifier
    const m1 = await cpost(`/orders/${ord.id}/line_items/${lineItemId}/modifications`, { modifier: { id: modifier.id }, name: modifier.name, amount: modifier.price });
    out.modification_1_status = m1.status;
    // 4. attach the SAME modifier again (idempotency probe)
    const m2 = await cpost(`/orders/${ord.id}/line_items/${lineItemId}/modifications`, { modifier: { id: modifier.id }, name: modifier.name, amount: modifier.price });
    out.modification_2_status = m2.status;
    // 5. read back
    const full = await cget(`/orders/${ord.id}?expand=lineItems,lineItems.modifications`);
    const liBack = (full.lineItems?.elements || []).find((x) => x.id === lineItemId);
    out.modifications_after_double_post = (liBack?.modifications?.elements || []).length;
    out.clover_dedups_modifications = out.modifications_after_double_post <= 1;
  }
  // 6. cleanup
  out.cleanup_delete_status = await cdel(`/orders/${ord.id}`);
  out.conclusion = out.line_item_create_status < 300 && out.modification_1_status < 300
    ? `native /modifications FEASIBLE; Clover dedups=${out.clover_dedups_modifications} → MCM-side idempotency ${out.clover_dedups_modifications ? 'not strictly' : 'REQUIRED'} (P1.6)`
    : 'native /modifications NOT cleanly usable in this sandbox config';
  fs.writeFileSync(__dirname + '/../evidence/E-modifications-spike.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
