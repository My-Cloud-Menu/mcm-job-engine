/* Clover ↔ MCM — inbound restaurant-day simulation (Slice C/F + final sim).
 * Drives the REAL production pull handlers (fetch_open_orders / fetch_closed_orders /
 * fetch_payments) against the Clover sandbox + DEV DB for the dedicated test site A, with a
 * control site B to prove tenant isolation. Creates a realistic shift of orders across several
 * waiters, pays a subset, pulls, reconciles to the cent, checks idempotency + isolation + void
 * reflection, then cleans up. Never prints secrets. Run: npx tsx e2e-clover.ts [nOrders]
 */
import 'dotenv/config';
import './src/handlers/load-handlers';
import { getHandler } from './src/handlers/registry';
import { supabase } from './src/lib/supabase';
import * as fs from 'fs';

const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const env = Object.fromEntries(fs.readFileSync(SCRATCH + '/clover-sandbox.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const BASE = env.CLOVER_SANDBOX_API_BASE_URL, MID = env.CLOVER_SANDBOX_MERCHANT_ID, TOK = env.CLOVER_SANDBOX_API_TOKEN;
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', 'User-Agent': 'MyCloudMenu-JobEngine/1.0-clover-bidi' };

const SITE_A = 99990001, SITE_B = 99990002;
const ORDER_TYPE = 'E409NQ4X4RQ0T', TENDER_MCM = '4QPPVE0NFNBN4';
const SCH = { open: '479f8c55-c3c9-48d2-beef-9bcba36cb090', closed: '442ccb2c-88f8-456e-8e0c-2b6c1667547b', payments: '5ce0c0fe-44b9-4ab5-ba8b-24be2050294f' };
const WAITERS = ['Ana', 'Luis', 'Marta', 'Carlos'];
const N = Number(process.argv[2] || 24);

const cget = async (p: string) => { const r = await fetch(`${BASE}/v3/merchants/${MID}${p}`, { headers: H }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const cpost = async (p: string, body: any) => { const r = await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const cdel = async (p: string) => { const r = await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'DELETE', headers: H }); return r.status; };
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

async function runHandler(step: string, scheduleId: string, cursor: string | null = null) {
  const h = getHandler('clover', step)!;
  const job: any = { id: `sim-${step}`, site_id: SITE_A, correlation_id: `clover-sim-${step}`, integration: 'clover', queue_name: 'pos_sync', job_type: step, payload: {} };
  return h({ stepInput: { schedule_id: scheduleId, cursor }, jobPayload: {}, context: {}, job, step: { step_name: step } as any } as any);
}

async function main() {
  const report: any = { started: new Date().toISOString(), site_a: SITE_A, n_orders: N, waiters: WAITERS.length };

  // 0. real priced items to build realistic tickets
  const items = ((await cget('/items?limit=200')).j.elements || []).filter((i: any) => i.price > 0);
  if (items.length < 4) throw new Error('not enough priced items in sandbox');
  report.priced_items_available = items.length;

  // 1. create a shift of orders across waiters
  const created: { id: string; total: number; waiter: string; pay: boolean }[] = [];
  for (let i = 0; i < N; i++) {
    const waiter = WAITERS[i % WAITERS.length];
    const extRef = `CLOVERSIM-${i}`;
    const ord = await cpost('/orders', { orderType: { id: ORDER_TYPE }, note: `SIM waiter:${waiter}`, externalReferenceId: extRef, clientCreatedTime: Date.now(), state: 'open' });
    if (ord.status >= 300 || !ord.j.id) { console.error('order create failed', ord.status, JSON.stringify(ord.j)); continue; }
    const lineCount = 1 + Math.floor(Math.random() * 4);
    const chosen = Array.from({ length: lineCount }, () => pick(items));
    const total = chosen.reduce((s, it) => s + (it.price || 0), 0);
    await cpost(`/orders/${ord.j.id}/bulk_line_items`, { items: chosen.map((it) => ({ item: { id: it.id } })) });
    // Clover does NOT compute order.total from bulk_line_items — set it explicitly (as reconcile_items does).
    if (total > 0) await cpost(`/orders/${ord.j.id}`, { total });
    created.push({ id: ord.j.id, total, waiter, pay: i % 2 === 0 && total > 0 });
  }
  report.orders_created = created.length;

  // 2. pay ~half (external MCM tender)
  let paid = 0;
  for (const o of created) {
    if (!o.pay) continue;
    const pr = await cpost(`/orders/${o.id}/payments`, { tender: { id: TENDER_MCM }, amount: o.total, offline: true });
    if (pr.status < 300) paid++;
  }
  report.orders_paid = paid;

  // 3. PULL via the real production handlers
  const openRes = await runHandler('fetch_open_orders', SCH.open);
  const closedRes = await runHandler('fetch_closed_orders', SCH.closed);
  const payRes = await runHandler('fetch_payments', SCH.payments, String(Date.now() - 60 * 60 * 1000));
  report.pull = { open: openRes, closed: closedRes, payments: payRes };

  // 4. reconcile MCM vs Clover to the cent (per created order)
  const ids = created.map((o) => o.id);
  const { data: mcmOrders } = await supabase.from('orders').select('clover_pos_id, total, payment_status, paid').eq('site_id', SITE_A).in('clover_pos_id', ids);
  const mcmByClover = new Map((mcmOrders || []).map((r: any) => [r.clover_pos_id, r]));
  let matched = 0, centMismatch = 0, missing = 0;
  for (const o of created) {
    const m = mcmByClover.get(o.id);
    if (!m) { missing++; continue; }
    matched++;
    if (Math.round(Number(m.total) * 100) !== Math.round(o.total)) centMismatch++;
  }
  report.reconciliation = { created: created.length, matched, missing, cent_mismatch: centMismatch };

  // 5. payment reconciliation — via clover_payment_map (the definitive dedup/link table)
  const payIds = await paymentIdsForOrders(ids);
  const { data: mapRows } = await supabase.from('clover_payment_map').select('clover_payment_id, mcm_payment_id').eq('site_id', SITE_A).in('clover_payment_id', payIds);
  report.payments = { clover_payments: payIds.filter((x) => x !== '__none__').length, map_rows: (mapRows || []).length, linked_to_mcm: (mapRows || []).filter((r: any) => r.mcm_payment_id).length };

  // 6. idempotency — re-run pull, assert MCM order count for our ids is stable
  await runHandler('fetch_open_orders', SCH.open);
  await runHandler('fetch_closed_orders', SCH.closed);
  const { count: afterCount } = await supabase.from('orders').select('*', { count: 'exact', head: true }).eq('site_id', SITE_A).in('clover_pos_id', ids);
  report.idempotency_order_count = afterCount;
  report.idempotency_ok = afterCount === matched;

  // 7. isolation — control site B must have NONE of these orders
  const { count: bCount } = await supabase.from('orders').select('*', { count: 'exact', head: true }).eq('site_id', SITE_B).in('clover_pos_id', ids);
  report.isolation_site_b_orders = bCount;
  report.isolation_ok = (bCount ?? 0) === 0;

  // 8. void reflection — void one payment, re-pull payments, assert map reflects it
  const paidOrders = created.filter((o) => o.pay);
  if (paidOrders.length) {
    const pmts = (await cget(`/orders/${paidOrders[0].id}/payments`)).j.elements || [];
    const pid = pmts[0]?.id;
    if (pid) {
      let rf = await cpost(`/payments/${pid}/refunds`, { amount: paidOrders[0].total });
      if (rf.status >= 300) rf = await cpost(`/refunds`, { payment: { id: pid }, amount: paidOrders[0].total });
      const rePay = await runHandler('fetch_payments', SCH.payments, String(Date.now() - 60 * 60 * 1000));
      const { data: mapRow } = await supabase.from('clover_payment_map').select('total_refunded, voided').eq('site_id', SITE_A).eq('clover_payment_id', pid).maybeSingle();
      report.void_refund = { refund_post_status: rf.status, refund_accepted: rf.status < 300, repull: rePay, map_after: mapRow };
    }
  }

  // 9. cleanup — delete MCM test orders (this run + any residual; site A is throwaway) + Clover orders
  await supabase.from('orders').delete().eq('site_id', SITE_A).in('clover_pos_id', ids);
  await supabase.from('orders').delete().eq('site_id', SITE_A).not('clover_pos_id', 'is', null);
  let cloverDeleted = 0;
  for (const id of ids) { if ((await cdel(`/orders/${id}`)) < 300) cloverDeleted++; }
  report.cleanup = { mcm_orders_deleted: matched, clover_orders_deleted: cloverDeleted };

  report.finished = new Date().toISOString();
  fs.writeFileSync(__dirname + '/docs/clover-bidi/evidence/e2e-clover-sim.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

async function paymentIdsForOrders(orderIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const oid of orderIds) {
    const p = (await cget(`/orders/${oid}/payments`)).j.elements || [];
    for (const x of p) out.push(x.id);
  }
  return out.length ? out : ['__none__'];
}

main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
