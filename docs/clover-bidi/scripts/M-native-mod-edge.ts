/* #4 edge cases for native outbound modifiers: multi-modifier, multi-line MIXED correlation,
 * invalid-modifier (non-fatal). Requires site A cloverNativeModifiers=true.
 * Run: npx tsx docs/clover-bidi/scripts/M-native-mod-edge.ts */
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
const job = (s: string) => ({ id: `m-${s}`, site_id: SITE_A, correlation_id: `m-${s}`, integration: 'clover', queue_name: 'pos_injection', job_type: s } as any);

// return per-line { name, mods } so correlation is verified BY NAME (robust to any GET ordering).
async function modsPerLine(orderId: string): Promise<Array<{ name: string; mods: string[] }>> {
  const full = await cget(`/orders/${orderId}?expand=lineItems,lineItems.modifications`);
  return (full.lineItems?.elements || []).map((li: any) => ({ name: li.name, mods: (li.modifications?.elements || []).map((m: any) => m.name) }));
}

async function pushOrder(lineItems: any[]): Promise<string> {
  const createH = getHandler('clover', 'create_order')!, reconcileH = getHandler('clover', 'reconcile_items')!;
  const { data: mo } = await supabase.from('orders').insert({ site_id: SITE_A, channel: 'pos' }).select('id').single();
  const orderId = (mo as any).id;
  const extRef = `NME${Math.floor(1000 + Math.random() * 8999)}`;
  const c: any = await createH({ jobPayload: { order_id: orderId, order_body: { orderType: { id: ORDER_TYPE }, externalReferenceId: extRef }, external_reference_id: extRef }, job: job('create_order'), step: { step_name: 'create_order' }, stepInput: {}, context: {} } as any);
  const cloverId = c.clover_order_id;
  await reconcileH({ jobPayload: { order_id: orderId, line_items: lineItems, line_items_hash: `h-${extRef}`, order_total_cents: 500 }, context: { create_order: { clover_order_id: cloverId } }, job: job('reconcile_items'), step: { step_name: 'reconcile_items' }, stepInput: {} } as any);
  await supabase.from('orders').delete().eq('site_id', SITE_A).eq('id', orderId);
  return cloverId;
}

async function main() {
  const report: any = {};
  const raw = ((await cget('/items?limit=100&orderBy=id')).elements || []).filter((i: any) => i.price > 0);
  const seenNames = new Set<string>(); const items: any[] = [];
  for (const it of raw) { if (!seenNames.has(it.name)) { seenNames.add(it.name); items.push(it); } if (items.length >= 3) break; }
  const group = ((await cget('/modifier_groups?limit=50&expand=modifiers')).elements || []).find((g: any) => (g.modifiers?.elements || []).length >= 3);
  const mods = group.modifiers.elements.slice(0, 3).map((m: any) => ({ id: m.id, name: m.name, amount: m.price }));
  const mod = (m: any) => ({ modifier: { id: m.id }, name: m.name, amount: m.amount });
  report.picked_modifiers = mods.map((m: any) => m.name);
  const cleanup: string[] = [];

  // S1: one line, TWO modifiers
  {
    const id = await pushOrder([{ name: items[0].name, price: items[0].price, unitQty: 1, modifiers: [mod(mods[0]), mod(mods[1])] }]);
    cleanup.push(id);
    const per = await modsPerLine(id);
    report.S1_multi_modifier = { per_line: per, ok: per.length === 1 && per[0].mods.length === 2 && per[0].mods.includes(mods[0].name) && per[0].mods.includes(mods[1].name) };
  }
  // S2: three lines MIXED [1 mod, 0 mod, 2 mods] — correlation by index must be exact
  {
    const id = await pushOrder([
      { name: items[0].name, price: items[0].price, unitQty: 1, modifiers: [mod(mods[0])] },
      { name: items[1].name, price: items[1].price, unitQty: 1 },
      { name: items[2].name, price: items[2].price, unitQty: 1, modifiers: [mod(mods[1]), mod(mods[2])] },
    ]);
    cleanup.push(id);
    const per = await modsPerLine(id);
    const byName = (n: string) => (per.find((l) => l.name === n)?.mods) || [];
    report.S2_mixed_correlation = { per_line: per, ok: byName(items[0].name).length === 1 && byName(items[1].name).length === 0 && byName(items[2].name).length === 2 };
  }
  // S3: invalid modifier id → non-fatal; order still created, the VALID modifier still attaches
  {
    const id = await pushOrder([{ name: items[0].name, price: items[0].price, unitQty: 1, modifiers: [{ modifier: { id: 'INVALIDMODID' }, name: 'Bad', amount: 0 }, mod(mods[0])] }]);
    cleanup.push(id);
    const per = await modsPerLine(id);
    const full = await cget(`/orders/${id}`);
    report.S3_invalid_modifier = { order_created: !!full.id, per_line: per, valid_attached: !!per[0]?.mods.includes(mods[0].name), no_crash: true };
  }

  report.ALL_OK = report.S1_multi_modifier.ok && report.S2_mixed_correlation.ok && report.S3_invalid_modifier.order_created && report.S3_invalid_modifier.valid_attached;
  for (const id of cleanup) await cdel(`/orders/${id}`);
  fs.writeFileSync(__dirname + '/../evidence/M-native-mod-edge.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
