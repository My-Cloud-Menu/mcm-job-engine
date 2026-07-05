/* Verify order-mapper improvements: a pulled Clover order with a line-item modification renders
 * its modifier (attributes[]) AND resolves product_id to the synced MCM product. Run:
 * npx tsx docs/clover-bidi/scripts/K-order-modifiers.ts  (requires site A catalog synced) */
import 'dotenv/config';
import '../../../src/handlers/load-handlers';
import { getHandler } from '../../../src/handlers/registry';
import { supabase } from '../../../src/lib/supabase';
import * as fs from 'fs';

const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const env = Object.fromEntries(fs.readFileSync(SCRATCH + '/clover-sandbox.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const BASE = env.CLOVER_SANDBOX_API_BASE_URL, MID = env.CLOVER_SANDBOX_MERCHANT_ID, TOK = env.CLOVER_SANDBOX_API_TOKEN;
const HH = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', 'User-Agent': 'MyCloudMenu-JobEngine/1.0-clover-bidi' };
const SITE_A = 99990001, ORDER_TYPE = 'E409NQ4X4RQ0T', SCH_OPEN = '479f8c55-c3c9-48d2-beef-9bcba36cb090';
const cget = async (p: string) => (await (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { headers: HH })).json().catch(() => ({})));
const cpost = async (p: string, b: any) => { const r = await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'POST', headers: HH, body: JSON.stringify(b) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const cdel = async (p: string) => (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'DELETE', headers: HH })).status;

async function main() {
  const report: any = {};
  const items = ((await cget('/items?limit=100&expand=modifierGroups')).elements || []).filter((i: any) => i.price > 0 && (i.modifierGroups?.elements || []).length > 0);
  const mg = (await cget('/modifier_groups?limit=50&expand=modifiers')).elements || [];
  const group = mg.find((g: any) => (g.modifiers?.elements || []).length > 0);
  const modifier = group?.modifiers?.elements?.[0];
  const item = items[0];
  report.picked = { item: item && { id: item.id, name: item.name }, modifier: modifier && { id: modifier.id, name: modifier.name } };

  const o = (await cpost('/orders', { orderType: { id: ORDER_TYPE }, note: 'K modifiers', clientCreatedTime: Date.now(), state: 'open' })).j;
  const li = await cpost(`/orders/${o.id}/line_items`, { item: { id: item.id } });
  const lineItemId = li.j?.id;
  await cpost(`/orders/${o.id}/line_items/${lineItemId}/modifications`, { modifier: { id: modifier.id }, name: modifier.name, amount: modifier.price });
  await cpost(`/orders/${o.id}`, { total: (item.price || 0) + (modifier.price || 0) });

  const h = getHandler('clover', 'fetch_open_orders')!;
  await h({ stepInput: { schedule_id: SCH_OPEN, cursor: null }, jobPayload: {}, context: {}, job: { id: 'k', site_id: SITE_A, correlation_id: 'k', integration: 'clover', queue_name: 'pos_sync', job_type: 'fetch_open_orders' } as any, step: { step_name: 'fetch_open_orders' } as any } as any);

  const { data: row } = await supabase.from('orders').select('line_items').eq('site_id', SITE_A).eq('clover_pos_id', o.id).maybeSingle();
  const lineItem = (row as any)?.line_items?.[0] || {};
  // expected MCM product id for this clover item
  const { data: prod } = await supabase.from('products').select('id').eq('site_id', SITE_A).contains('additional_properties', { cloverId: String(item.id) }).limit(1).maybeSingle();
  report.result = {
    line_item_name: lineItem.name,
    attributes: lineItem.attributes,
    modifier_rendered: Array.isArray(lineItem.attributes) && lineItem.attributes.some((a: any) => (a.value || a.label) === modifier.name),
    additional_properties_modifiers: lineItem.additional_properties?.modifiers,
    product_id: lineItem.product_id,
    expected_mcm_product_id: prod ? String((prod as any).id) : null,
    product_id_resolved_to_mcm: prod ? lineItem.product_id === String((prod as any).id) : false,
    clover_correlation: lineItem.additional_properties?.clover,
  };
  await supabase.from('orders').delete().eq('site_id', SITE_A).eq('clover_pos_id', o.id);
  await cdel(`/orders/${o.id}`);
  fs.writeFileSync(__dirname + '/../evidence/K-order-modifiers.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
