/* Edge-case hunt for the outbound reconcile path (production-grade robustness):
 *  E1: >100 line items (big party) — must chunk bulk_line_items (Clover 100/request cap).
 *  E2: duplicate IDENTICAL items with native modifiers — each line must get its own modifier.
 *  E3: zero-price item — must reconcile fine.
 *  E4: empty line_items — must not crash.
 * Requires site A cloverNativeModifiers=true. Run: npx tsx docs/clover-bidi/scripts/N-edge-hunt.ts */
import 'dotenv/config';
import '../../../src/handlers/load-handlers';
import { getHandler } from '../../../src/handlers/registry';
import { supabase } from '../../../src/lib/supabase';
import * as fs from 'fs';

const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const env = Object.fromEntries(fs.readFileSync(SCRATCH + '/clover-sandbox.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const BASE = env.CLOVER_SANDBOX_API_BASE_URL, MID = env.CLOVER_SANDBOX_MERCHANT_ID, TOK = env.CLOVER_SANDBOX_API_TOKEN;
const HH = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', 'User-Agent': 'x' };
const ORDER_TYPE = 'E409NQ4X4RQ0T';
const cget = async (p: string) => (await (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { headers: HH })).json().catch(() => ({})));
const cdel = async (p: string) => (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'DELETE', headers: HH })).status;
const job = (s: string) => ({ id: s, site_id: 99990001, correlation_id: s, integration: 'clover', queue_name: 'pos_injection', job_type: s } as any);

async function push(lineItems: any[], totalCents: number): Promise<{ cloverId: string; error?: string }> {
  const createH = getHandler('clover', 'create_order')!, reconcileH = getHandler('clover', 'reconcile_items')!;
  const { data: mo } = await supabase.from('orders').insert({ site_id: 99990001, channel: 'pos' }).select('id').single();
  const orderId = (mo as any).id;
  const extRef = `EH${Math.floor(1000 + Math.random() * 8999)}`;
  const c: any = await createH({ jobPayload: { order_id: orderId, order_body: { orderType: { id: ORDER_TYPE }, externalReferenceId: extRef }, external_reference_id: extRef }, job: job('create_order'), step: { step_name: 'create_order' }, stepInput: {}, context: {} } as any);
  const cloverId = c.clover_order_id;
  let error;
  try {
    await reconcileH({ jobPayload: { order_id: orderId, line_items: lineItems, line_items_hash: `h-${extRef}`, order_total_cents: totalCents }, context: { create_order: { clover_order_id: cloverId } }, job: job('reconcile_items'), step: { step_name: 'reconcile_items' }, stepInput: {} } as any);
  } catch (e: any) { error = e?.message || String(e); }
  await supabase.from('orders').delete().eq('site_id', 99990001).eq('id', orderId);
  return { cloverId, error };
}
async function lineCount(id: string) { const g = await cget(`/orders/${id}?expand=lineItems`); return (g.lineItems?.elements || []).length; }
async function modsPerLine(id: string) { const g = await cget(`/orders/${id}?expand=lineItems,lineItems.modifications`); return (g.lineItems?.elements || []).map((li: any) => ({ name: li.name, mods: (li.modifications?.elements || []).map((m: any) => m.name) })); }

async function main() {
  const report: any = {};
  const cleanup: string[] = [];
  const items = ((await cget('/items?limit=100')).elements || []).filter((i: any) => i.price > 0);
  const group = ((await cget('/modifier_groups?limit=50&expand=modifiers')).elements || []).find((g: any) => (g.modifiers?.elements || []).length >= 2);
  const mods = group.modifiers.elements.slice(0, 2).map((m: any) => ({ id: m.id, name: m.name, amount: m.price }));
  const md = (m: any) => ({ modifier: { id: m.id }, name: m.name, amount: m.amount });

  // E1: 120 line items (>100 cap) — chunking must land all 120
  {
    const N = 120;
    const li = Array.from({ length: N }, (_, i) => ({ name: `Big ${i}`, price: 100, unitQty: 1 }));
    const r = await push(li, N * 100);
    cleanup.push(r.cloverId);
    report.E1_over_100_items = { sent: N, landed: await lineCount(r.cloverId), error: r.error || null, ok: !r.error && (await lineCount(r.cloverId)) === N };
  }
  // E2: two IDENTICAL items, each with a DIFFERENT native modifier — both must attach (1 per line)
  {
    const li = [
      { name: items[0].name, price: items[0].price, unitQty: 1, modifiers: [md(mods[0])] },
      { name: items[0].name, price: items[0].price, unitQty: 1, modifiers: [md(mods[1])] },
    ];
    const r = await push(li, items[0].price * 2);
    cleanup.push(r.cloverId);
    const per = await modsPerLine(r.cloverId);
    const allMods = per.flatMap((l: any) => l.mods).sort();
    report.E2_duplicate_items_mods = { per, ok: per.length === 2 && per.every((l: any) => l.mods.length === 1) && JSON.stringify(allMods) === JSON.stringify([mods[0].name, mods[1].name].sort()) };
  }
  // E3: zero-price item
  {
    const zero = ((await cget('/items?limit=100')).elements || []).find((i: any) => i.price === 0);
    const li = [{ name: zero?.name || 'Free', price: 0, unitQty: 1 }];
    const r = await push(li, 0);
    cleanup.push(r.cloverId);
    report.E3_zero_price = { landed: await lineCount(r.cloverId), error: r.error || null, ok: !r.error && (await lineCount(r.cloverId)) === 1 };
  }
  // E4: empty line items
  {
    const r = await push([], 0);
    cleanup.push(r.cloverId);
    report.E4_empty = { landed: await lineCount(r.cloverId), error: r.error || null, ok: !r.error };
  }

  report.ALL_OK = report.E1_over_100_items.ok && report.E2_duplicate_items_mods.ok && report.E3_zero_price.ok && report.E4_empty.ok;
  for (const id of cleanup) await cdel(`/orders/${id}`);
  fs.writeFileSync(__dirname + '/../evidence/N-edge-hunt.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
