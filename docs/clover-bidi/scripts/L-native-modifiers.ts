/* #4 verify — native outbound modifiers: reconcile_items attaches catalog modifiers to Clover
 * line items via /modifications, idempotent via DELETE+RECREATE. Requires site A config
 * cloverNativeModifiers=true. Run: npx tsx docs/clover-bidi/scripts/L-native-modifiers.ts */
import 'dotenv/config';
import '../../../src/handlers/load-handlers';
import { getHandler } from '../../../src/handlers/registry';
import { supabase } from '../../../src/lib/supabase';
import * as fs from 'fs';

const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const env = Object.fromEntries(fs.readFileSync(SCRATCH + '/clover-sandbox.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const BASE = env.CLOVER_SANDBOX_API_BASE_URL, MID = env.CLOVER_SANDBOX_MERCHANT_ID, TOK = env.CLOVER_SANDBOX_API_TOKEN;
const HH = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', 'User-Agent': 'MyCloudMenu-JobEngine/1.0-clover-bidi' };
const SITE_A = 99990001, ORDER_TYPE = 'E409NQ4X4RQ0T';
const cget = async (p: string) => (await (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { headers: HH })).json().catch(() => ({})));
const cdel = async (p: string) => (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'DELETE', headers: HH })).status;

function job(step: string) { return { id: `l-${step}`, site_id: SITE_A, correlation_id: `l-${step}`, integration: 'clover', queue_name: 'pos_injection', job_type: step } as any; }
async function modsOnOrder(orderId: string) {
  const full = await cget(`/orders/${orderId}?expand=lineItems,lineItems.modifications`);
  return (full.lineItems?.elements || []).flatMap((li: any) => (li.modifications?.elements || []).map((m: any) => m.name));
}

async function main() {
  const report: any = {};
  const items = ((await cget('/items?limit=100')).elements || []).filter((i: any) => i.price > 0);
  const group = ((await cget('/modifier_groups?limit=50&expand=modifiers')).elements || []).find((g: any) => (g.modifiers?.elements || []).length > 0);
  const modifier = group?.modifiers?.elements?.[0];
  const item = items[0];
  report.picked = { item: item?.name, modifier: modifier?.name };

  const createH = getHandler('clover', 'create_order')!, reconcileH = getHandler('clover', 'reconcile_items')!;
  const { data: mo } = await supabase.from('orders').insert({ site_id: SITE_A, channel: 'pos' }).select('id').single();
  const orderId = (mo as any).id;
  const extRef = `NMOD${Math.floor(1000 + Math.random() * 8999)}`;
  const c: any = await createH({ jobPayload: { order_id: orderId, order_body: { orderType: { id: ORDER_TYPE }, externalReferenceId: extRef }, external_reference_id: extRef }, job: job('create_order'), step: { step_name: 'create_order' }, stepInput: {}, context: {} } as any);
  const cloverId = c.clover_order_id;

  // line item carries a native modifier
  const lineItems = [{ name: item.name, price: item.price, unitQty: 1, modifiers: [{ modifier: { id: modifier.id }, name: modifier.name, amount: modifier.price }] }];
  const rjp = { order_id: orderId, line_items: lineItems, line_items_hash: `h-${extRef}`, order_total_cents: item.price + modifier.price };
  const ctx = { create_order: { clover_order_id: cloverId } };
  await reconcileH({ jobPayload: rjp, context: ctx, job: job('reconcile_items'), step: { step_name: 'reconcile_items' }, stepInput: {} } as any);
  report.after_first_reconcile = await modsOnOrder(cloverId);
  report.modifier_attached = report.after_first_reconcile.includes(modifier.name);

  // idempotency: re-run reconcile with a different hash (forces re-reconcile) → DELETE+RECREATE → still exactly 1
  const rjp2 = { ...rjp, line_items_hash: `h-${extRef}-v2` };
  await reconcileH({ jobPayload: rjp2, context: ctx, job: job('reconcile_items'), step: { step_name: 'reconcile_items' }, stepInput: {} } as any);
  report.after_second_reconcile = await modsOnOrder(cloverId);
  report.idempotent_no_accumulation = report.after_second_reconcile.filter((n: string) => n === modifier.name).length === 1;

  await supabase.from('orders').delete().eq('site_id', SITE_A).eq('id', orderId);
  await cdel(`/orders/${cloverId}`);
  fs.writeFileSync(__dirname + '/../evidence/L-native-modifiers.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
