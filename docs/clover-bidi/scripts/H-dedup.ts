/* Exhaustive ORDER-DEDUPLICATION hardening. Focus: prove Clover orders NEVER duplicate in MCM.
 * Scenarios:
 *  S1 outbound→inbound (WS-6/F12): push an MCM order to Clover (create_order persists
 *     clover_ticket_id), then pull → the SAME MCM row is found by clover_ticket_id and updated,
 *     NOT inserted again. Exactly 1 MCM row for that Clover id.
 *  S2 high concurrency: N orders, 8 parallel fetch_open_orders → exactly 1 MCM row each.
 *  S3 repeated sequential pulls (6×) → counts stay at 1 (idempotent inserts).
 *  S4 payment concurrency: paid orders, 4 parallel fetch_payments → 1 clover_payment_map row each.
 * Cleans up. Never prints secrets. Run: npx tsx docs/clover-bidi/scripts/H-dedup.ts
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
const SITE_A = 99990001, ORDER_TYPE = 'E409NQ4X4RQ0T';
const SCH_OPEN = '479f8c55-c3c9-48d2-beef-9bcba36cb090', SCH_CLOSED = '442ccb2c-88f8-456e-8e0c-2b6c1667547b', SCH_PAY = '5ce0c0fe-44b9-4ab5-ba8b-24be2050294f';
const TENDER_MCM = '4QPPVE0NFNBN4';

const cget = async (p: string) => (await (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { headers: HH })).json().catch(() => ({})));
const cpost = async (p: string, b: any) => { const r = await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'POST', headers: HH, body: JSON.stringify(b) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const cdel = async (p: string) => (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'DELETE', headers: HH })).status;
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function run(step: string, scheduleId: string, cursor: string | null = null, extraCtx: any = {}) {
  const h = getHandler('clover', step)!;
  const job: any = { id: `h-${step}`, site_id: SITE_A, correlation_id: `clover-dedup-${step}`, integration: 'clover', queue_name: step === 'create_order' || step === 'reconcile_items' ? 'pos_injection' : 'pos_sync', job_type: step, payload: {} };
  return h({ stepInput: { schedule_id: scheduleId, cursor }, jobPayload: extraCtx.jobPayload || {}, context: extraCtx.context || {}, job, step: { step_name: step } as any } as any);
}
const countRows = async (cloverId: string) => {
  const { count } = await supabase.from('orders').select('*', { count: 'exact', head: true }).eq('site_id', SITE_A).or(`clover_pos_id.eq.${cloverId},clover_ticket_id.eq.${cloverId}`);
  return count ?? 0;
};

async function main() {
  const report: any = { started: new Date().toISOString() };
  const items = ((await cget('/items?limit=100')).elements || []).filter((i: any) => i.price > 0);
  const createH = getHandler('clover', 'create_order')!, reconcileH = getHandler('clover', 'reconcile_items')!;
  const cleanupCloverIds: string[] = [];

  // ── S1: outbound→inbound dedup (WS-6/F12) ─────────────────────────────────
  {
    const { data: mo } = await supabase.from('orders').insert({ site_id: SITE_A, channel: 'pos' }).select('id').single();
    const mcmId = (mo as any).id;
    const extRef = `DUP${Math.floor(1000 + Math.random() * 8999)}`;
    const chosen = [pick(items), pick(items)] as any[];
    const total = chosen.reduce((s, it) => s + it.price, 0);
    const orderBody = { orderType: { id: ORDER_TYPE }, externalReferenceId: extRef, clientCreatedTime: Date.now(), state: 'open' };
    const c: any = await createH({ jobPayload: { order_id: mcmId, order_body: orderBody, external_reference_id: extRef }, job: { id: 'c', site_id: SITE_A, correlation_id: 'x', integration: 'clover', queue_name: 'pos_injection', job_type: 'create_order' }, step: { step_name: 'create_order' }, stepInput: {}, context: {} } as any);
    const cloverId = c?.clover_order_id; if (cloverId) cleanupCloverIds.push(cloverId);
    const lineItems = chosen.map((it) => ({ name: it.name, price: it.price, unitQty: 1 }));
    await reconcileH({ jobPayload: { order_id: mcmId, line_items: lineItems, line_items_hash: `h-${extRef}`, order_total_cents: total }, context: { create_order: { clover_order_id: cloverId } }, job: { id: 'r', site_id: SITE_A, correlation_id: 'x', integration: 'clover', queue_name: 'pos_injection', job_type: 'reconcile_items' }, step: { step_name: 'reconcile_items' }, stepInput: {} } as any);
    // now pull — must NOT create a duplicate; must update the SAME row (mcmId)
    await run('fetch_open_orders', SCH_OPEN);
    const rows = (await supabase.from('orders').select('id, clover_pos_id, clover_ticket_id').eq('site_id', SITE_A).or(`clover_pos_id.eq.${cloverId},clover_ticket_id.eq.${cloverId}`));
    const matched = rows.data || [];
    report.S1_outbound_then_inbound = {
      clover_id: cloverId, rows_found: matched.length, same_row_id: matched.length === 1 && matched[0].id === mcmId,
      clover_pos_id_set: matched[0]?.clover_pos_id === cloverId, no_duplicate: matched.length === 1,
    };
    await supabase.from('orders').delete().eq('site_id', SITE_A).eq('id', mcmId);
  }

  // ── S2: high concurrency (8 parallel pulls) ───────────────────────────────
  {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const chosen = [pick(items)] as any[];
      const o = (await cpost('/orders', { orderType: { id: ORDER_TYPE }, note: `DEDUP-S2-${i}`, clientCreatedTime: Date.now(), state: 'open' })).j;
      await cpost(`/orders/${o.id}/bulk_line_items`, { items: chosen.map((it) => ({ name: it.name, price: it.price, unitQty: 1 })) });
      await cpost(`/orders/${o.id}`, { total: chosen.reduce((s, it) => s + it.price, 0) });
      ids.push(o.id); cleanupCloverIds.push(o.id);
    }
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => run('fetch_open_orders', SCH_OPEN)));
    const counts: Record<string, number> = {};
    for (const id of ids) counts[id] = await countRows(id);
    report.S2_concurrency = { parallel_pulls: res.length, fulfilled: res.filter((r) => r.status === 'fulfilled').length, rows_per_order: counts, no_duplicates: Object.values(counts).every((c) => c === 1) };
    await supabase.from('orders').delete().eq('site_id', SITE_A).in('clover_pos_id', ids);
  }

  // ── S3: repeated sequential pulls (6×) ────────────────────────────────────
  {
    const chosen = [pick(items)] as any[];
    const o = (await cpost('/orders', { orderType: { id: ORDER_TYPE }, note: 'DEDUP-S3', clientCreatedTime: Date.now(), state: 'open' })).j;
    await cpost(`/orders/${o.id}/bulk_line_items`, { items: chosen.map((it) => ({ name: it.name, price: it.price, unitQty: 1 })) });
    await cpost(`/orders/${o.id}`, { total: chosen.reduce((s, it) => s + it.price, 0) });
    cleanupCloverIds.push(o.id);
    const perPull: number[] = [];
    for (let i = 0; i < 6; i++) { await run('fetch_open_orders', SCH_OPEN); perPull.push(await countRows(o.id)); }
    report.S3_repeated_pulls = { counts_after_each_pull: perPull, always_one: perPull.every((c) => c === 1) };
    await supabase.from('orders').delete().eq('site_id', SITE_A).eq('clover_pos_id', o.id);
  }

  // ── S4: payment concurrency ───────────────────────────────────────────────
  {
    const ids: string[] = []; const payIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const it = pick(items) as any;
      const o = (await cpost('/orders', { orderType: { id: ORDER_TYPE }, note: `DEDUP-S4-${i}`, clientCreatedTime: Date.now(), state: 'open' })).j;
      await cpost(`/orders/${o.id}/bulk_line_items`, { items: [{ name: it.name, price: it.price, unitQty: 1 }] });
      await cpost(`/orders/${o.id}`, { total: it.price });
      const p = await cpost(`/orders/${o.id}/payments`, { tender: { id: TENDER_MCM }, amount: it.price, offline: true });
      if (p.j?.id) payIds.push(p.j.id);
      ids.push(o.id); cleanupCloverIds.push(o.id);
    }
    await run('fetch_open_orders', SCH_OPEN); // orders must exist for payment linkage
    const cur = String(Date.now() - 60 * 60 * 1000);
    await Promise.allSettled(Array.from({ length: 4 }, () => run('fetch_payments', SCH_PAY, cur)));
    const mapCounts: Record<string, number> = {};
    for (const pid of payIds) { const { count } = await supabase.from('clover_payment_map').select('*', { count: 'exact', head: true }).eq('site_id', SITE_A).eq('clover_payment_id', pid); mapCounts[pid] = count ?? 0; }
    report.S4_payment_concurrency = { payments: payIds.length, map_rows_per_payment: mapCounts, no_duplicate_map_rows: Object.values(mapCounts).every((c) => c === 1) };
    await supabase.from('orders').delete().eq('site_id', SITE_A).in('clover_pos_id', ids);
  }

  // final purge + clover cleanup
  await supabase.from('orders').delete().eq('site_id', SITE_A).not('clover_pos_id', 'is', null);
  let del = 0; for (const id of cleanupCloverIds) { if ((await cdel(`/orders/${id}`)) < 300) del++; }
  report.cleanup = { clover_deleted: del };
  report.ALL_DEDUP_OK = report.S1_outbound_then_inbound.no_duplicate && report.S2_concurrency.no_duplicates && report.S3_repeated_pulls.always_one && report.S4_payment_concurrency.no_duplicate_map_rows;

  report.finished = new Date().toISOString();
  fs.writeFileSync(__dirname + '/../evidence/H-dedup.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
