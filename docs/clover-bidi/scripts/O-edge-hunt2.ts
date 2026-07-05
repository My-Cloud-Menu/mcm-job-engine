/* Edge-case hunt #2:
 *  E5: >100 line items WITH native modifiers on lines spanning chunk boundaries — chunk-accumulated
 *      `created` must still correlate modifiers to the right lines.
 *  E6: item names with special characters (quotes, unicode, emoji) — must round-trip intact.
 * Requires site A cloverNativeModifiers=true. Run: npx tsx docs/clover-bidi/scripts/O-edge-hunt2.ts */
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
async function push(lineItems: any[], totalCents: number): Promise<string> {
  const createH = getHandler('clover', 'create_order')!, reconcileH = getHandler('clover', 'reconcile_items')!;
  const { data: mo } = await supabase.from('orders').insert({ site_id: 99990001, channel: 'pos' }).select('id').single();
  const orderId = (mo as any).id;
  const extRef = `EH2${Math.floor(100 + Math.random() * 899)}`;
  const c: any = await createH({ jobPayload: { order_id: orderId, order_body: { orderType: { id: ORDER_TYPE }, externalReferenceId: extRef }, external_reference_id: extRef }, job: job('create_order'), step: { step_name: 'create_order' }, stepInput: {}, context: {} } as any);
  await reconcileH({ jobPayload: { order_id: orderId, line_items: lineItems, line_items_hash: `h-${extRef}`, order_total_cents: totalCents }, context: { create_order: { clover_order_id: c.clover_order_id } }, job: job('reconcile_items'), step: { step_name: 'reconcile_items' }, stepInput: {} } as any);
  await supabase.from('orders').delete().eq('site_id', 99990001).eq('id', orderId);
  return c.clover_order_id;
}
async function main() {
  const report: any = {}; const cleanup: string[] = [];
  const group = ((await cget('/modifier_groups?limit=50&expand=modifiers')).elements || []).find((g: any) => (g.modifiers?.elements || []).length >= 3);
  const mods = group.modifiers.elements.slice(0, 3).map((m: any) => ({ id: m.id, name: m.name, amount: m.price }));
  const md = (m: any) => ({ modifier: { id: m.id }, name: m.name, amount: m.amount });

  // E5: 105 items, modifiers on lines 0, 60, 104 (spanning both chunks); names distinct so (name,price) is unique
  {
    const N = 105;
    const li = Array.from({ length: N }, (_, i) => {
      const base: any = { name: `Chunk ${i}`, price: 100, unitQty: 1 };
      if (i === 0) base.modifiers = [md(mods[0])];
      if (i === 60) base.modifiers = [md(mods[1])];
      if (i === 104) base.modifiers = [md(mods[2])];
      return base;
    });
    const id = await push(li, N * 100); cleanup.push(id);
    const g = await cget(`/orders/${id}?expand=lineItems,lineItems.modifications`);
    const lines = (g.lineItems?.elements || []);
    const byName: Record<string, string[]> = {};
    for (const l of lines) byName[l.name] = (l.modifications?.elements || []).map((m: any) => m.name);
    report.E5_chunk_boundary_mods = {
      total_lines: lines.length,
      line0: byName['Chunk 0'], line60: byName['Chunk 60'], line104: byName['Chunk 104'],
      ok: lines.length === N && byName['Chunk 0']?.[0] === mods[0].name && byName['Chunk 60']?.[0] === mods[1].name && byName['Chunk 104']?.[0] === mods[2].name,
    };
  }
  // E6: special characters in line name
  {
    const weird = 'Café «Niño» "quote" 🌮 & <b> 50%';
    const id = await push([{ name: weird, price: 250, unitQty: 1 }], 250); cleanup.push(id);
    const g = await cget(`/orders/${id}?expand=lineItems`);
    const name = (g.lineItems?.elements || [])[0]?.name;
    report.E6_special_chars = { sent: weird, got: name, ok: name === weird };
  }
  report.ALL_OK = report.E5_chunk_boundary_mods.ok && report.E6_special_chars.ok;
  for (const id of cleanup) await cdel(`/orders/${id}`);
  fs.writeFileSync(__dirname + '/../evidence/O-edge-hunt2.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
