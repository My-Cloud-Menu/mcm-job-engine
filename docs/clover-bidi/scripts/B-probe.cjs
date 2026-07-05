/* Slice B recon — inventory of the Clover sandbox merchant so we know what to test against.
 * Reads creds from scratchpad clover-sandbox.env (never printed). Prints only counts + non-secret shape.
 */
const fs = require('fs');
const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const env = Object.fromEntries(fs.readFileSync(SCRATCH + '/clover-sandbox.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const BASE = env.CLOVER_SANDBOX_API_BASE_URL, MID = env.CLOVER_SANDBOX_MERCHANT_ID, TOK = env.CLOVER_SANDBOX_API_TOKEN;
const H = { Authorization: `Bearer ${TOK}`, 'User-Agent': 'MyCloudMenu-JobEngine/1.0-clover-bidi' };
const get = async (p) => { const r = await fetch(`${BASE}/v3/merchants/${MID}${p}`, { headers: H }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } return { status: r.status, j }; };

(async () => {
  const out = {};
  // employees + PIN presence (P1.4)
  const emp = await get('/employees?limit=100');
  const emps = (emp.j && emp.j.elements) || [];
  out.employees = { status: emp.status, count: emps.length,
    with_unhashedPin: emps.filter(e => e.unhashedPin != null && e.unhashedPin !== '').length,
    roles: [...new Set(emps.map(e => e.role))],
    sample: emps.slice(0, 3).map(e => ({ id: e.id, name: e.name, role: e.role, hasUnhashedPin: e.unhashedPin != null && e.unhashedPin !== '' })) };
  // categories
  const cat = await get('/categories?limit=100');
  out.categories = { status: cat.status, count: (cat.j.elements || []).length, sample: (cat.j.elements || []).slice(0, 3).map(c => ({ id: c.id, name: c.name })) };
  // items (with expands used by inventory sync)
  const items = await get('/items?limit=5&expand=categories,itemStock,modifierGroups');
  const its = (items.j && items.j.elements) || [];
  out.items = { status: items.status, sample_count: its.length,
    sample: its.slice(0, 3).map(i => ({ id: i.id, name: i.name, price: i.price, available: i.available,
      hasItemStock: !!i.itemStock, itemStock: i.itemStock ? { quantity: i.itemStock.quantity, stockCount: i.itemStock.stockCount } : null,
      categories: (i.categories && i.categories.elements || []).map(c => c.id),
      modifierGroups: (i.modifierGroups && i.modifierGroups.elements || []).map(g => g.id) })) };
  // total item count via ?limit=1000 length (rough)
  const itAll = await get('/items?limit=1000');
  out.items.total_first_page = (itAll.j && itAll.j.elements || []).length;
  // modifier groups + modifiers
  const mg = await get('/modifier_groups?limit=100&expand=modifiers');
  const mgs = (mg.j && mg.j.elements) || [];
  out.modifier_groups = { status: mg.status, count: mgs.length, sample: mgs.slice(0, 3).map(g => ({ id: g.id, name: g.name, modifiers: (g.modifiers && g.modifiers.elements || []).map(m => ({ id: m.id, name: m.name, price: m.price })) })) };
  // item_stocks (86)
  const st = await get('/item_stocks?limit=100');
  out.item_stocks = { status: st.status, count: (st.j && st.j.elements || []).length, sample: (st.j && st.j.elements || []).slice(0, 3).map(s => ({ item: s.item && s.item.id, quantity: s.quantity, stockCount: s.stockCount })) };
  // order types / does an order carry a table? (spike P1.5 — check one order)
  const ot = await get('/order_types?limit=100');
  out.order_types = { status: ot.status, count: (ot.j && ot.j.elements || []).length, sample: (ot.j && ot.j.elements || []).slice(0, 5).map(o => ({ id: o.id, label: o.label })) };
  const ords = await get('/orders?limit=3&expand=lineItems,payments,employee');
  const os = (ords.j && ords.j.elements) || [];
  out.orders_probe = { status: ords.status, count: os.length, sample: os.slice(0, 2).map(o => ({ id: o.id, state: o.state, hasEmployee: !!o.employee, employeeId: o.employee && o.employee.id, keys: Object.keys(o) })) };

  fs.writeFileSync(__dirname + '/../evidence/B-probe.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
