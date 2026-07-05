/* Slice-final hardening — inbound edge cases:
 *  (1) CONCURRENCY: run N fetch_open_orders in parallel → each Clover order must yield exactly
 *      ONE MCM order (no duplicate) — tests the onConflict(site_id,clover_pos_id) dedup (P2.7).
 *  (2) UPDATE path: edit a Clover order (new total + extra line item) → re-pull → the MCM order
 *      is UPDATED in place (total changes, still exactly 1 row).
 * Creates a few orders on site A, then cleans up. Never prints secrets.
 * Run: npx tsx docs/clover-bidi/scripts/G-edgecases.ts
 */
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
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function pull() {
  const h = getHandler('clover', 'fetch_open_orders')!;
  const job: any = { id: 'g-pull', site_id: SITE_A, correlation_id: 'clover-edge', integration: 'clover', queue_name: 'pos_sync', job_type: 'fetch_open_orders', payload: {} };
  return h({ stepInput: { schedule_id: SCH_OPEN, cursor: null }, jobPayload: {}, context: {}, job, step: { step_name: 'fetch_open_orders' } as any } as any);
}

async function main() {
  const report: any = { started: new Date().toISOString() };
  const items = ((await cget('/items?limit=100')).elements || []).filter((i: any) => i.price > 0);

  // create 3 orders
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const chosen = [pick(items), pick(items)] as any[];
    const total = chosen.reduce((s, it) => s + it.price, 0);
    const o = (await cpost('/orders', { orderType: { id: ORDER_TYPE }, note: `EDGE ${i}`, clientCreatedTime: Date.now(), state: 'open' })).j;
    await cpost(`/orders/${o.id}/bulk_line_items`, { items: chosen.map((it) => ({ name: it.name, price: it.price, unitQty: 1 })) });
    await cpost(`/orders/${o.id}`, { total });
    ids.push(o.id);
  }

  // (1) CONCURRENCY — 4 pulls in parallel
  const conc = await Promise.allSettled([pull(), pull(), pull(), pull()]);
  report.concurrent_pulls = conc.map((r) => (r.status === 'fulfilled' ? 'ok' : 'rejected'));
  const dupCheck: Record<string, number> = {};
  for (const id of ids) {
    const { count } = await supabase.from('orders').select('*', { count: 'exact', head: true }).eq('site_id', SITE_A).eq('clover_pos_id', id);
    dupCheck[id] = count ?? 0;
  }
  report.rows_per_order = dupCheck;
  report.no_duplicates = Object.values(dupCheck).every((c) => c === 1);

  // (2) UPDATE path — change total + add a line item on the first order, re-pull
  const target = ids[0];
  const extra = pick(items) as any;
  const before = (await cget(`/orders/${target}?expand=lineItems`));
  const newTotal = (before.total || 0) + extra.price;
  await cpost(`/orders/${target}/bulk_line_items`, { items: [{ name: extra.name, price: extra.price, unitQty: 1 }] });
  await cpost(`/orders/${target}`, { total: newTotal });
  await pull();
  const { data: after } = await supabase.from('orders').select('total').eq('site_id', SITE_A).eq('clover_pos_id', target).maybeSingle();
  const { count: afterCount } = await supabase.from('orders').select('*', { count: 'exact', head: true }).eq('site_id', SITE_A).eq('clover_pos_id', target);
  report.update_path = { new_total_cents: newTotal, mcm_total_after: after?.total, cent_match: Math.round(Number(after?.total) * 100) === Math.round(newTotal), still_single_row: afterCount === 1 };

  // cleanup
  await supabase.from('orders').delete().eq('site_id', SITE_A).in('clover_pos_id', ids);
  let del = 0; for (const id of ids) { if ((await cdel(`/orders/${id}`)) < 300) del++; }
  report.cleanup = { clover_deleted: del };

  report.finished = new Date().toISOString();
  fs.writeFileSync(__dirname + '/../evidence/G-edgecases.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
