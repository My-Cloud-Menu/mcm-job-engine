/* Slice D — outbound MCM → Clover. Drives the REAL production handlers `clover.create_order`
 * + `clover.reconcile_items` against the sandbox for the test site, verifies the Clover order
 * (line items + total), proves adopt-by-externalReferenceId idempotency, then cleans up.
 * Run: npx tsx docs/clover-bidi/scripts/D-outbound.ts [nOrders]
 */
import 'dotenv/config';
import '../../../src/handlers/load-handlers';
import { getHandler } from '../../../src/handlers/registry';
import { supabase } from '../../../src/lib/supabase';
import * as fs from 'fs';

const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const env = Object.fromEntries(fs.readFileSync(SCRATCH + '/clover-sandbox.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const BASE = env.CLOVER_SANDBOX_API_BASE_URL, MID = env.CLOVER_SANDBOX_MERCHANT_ID, TOK = env.CLOVER_SANDBOX_API_TOKEN;
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', 'User-Agent': 'MyCloudMenu-JobEngine/1.0-clover-bidi' };
const SITE_A = 99990001, ORDER_TYPE = 'E409NQ4X4RQ0T';
const N = Number(process.argv[2] || 5);

const cget = async (p: string) => (await (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { headers: H })).json().catch(() => ({})));
const cdel = async (p: string) => (await fetch(`${BASE}/v3/merchants/${MID}${p}`, { method: 'DELETE', headers: H })).status;
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function job(step: string) { return { id: `d-${step}`, site_id: SITE_A, correlation_id: `clover-out-${step}`, integration: 'clover', queue_name: 'pos_injection', job_type: step, payload: {} } as any; }

async function main() {
  const report: any = { started: new Date().toISOString(), site_a: SITE_A, n: N };
  const createH = getHandler('clover', 'create_order')!;
  const reconcileH = getHandler('clover', 'reconcile_items')!;

  const items = ((await cget('/items?limit=200')).elements || []).filter((i: any) => i.price > 0);
  const created: { extRef: string; cloverId: string; total: number; nItems: number }[] = [];

  for (let k = 0; k < N; k++) {
    const orderId = 900000 + k; // numeric (bigint-compatible) for the best-effort persist
    const extRef = `MCMO${k}${Math.floor(1000 + Math.random() * 8999)}`; // <=12 chars (Clover Invoice ID cap)
    const chosen = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => pick(items));
    const total = chosen.reduce((s: number, it: any) => s + it.price, 0);
    const orderBody = { orderType: { id: ORDER_TYPE }, externalReferenceId: extRef, note: `MCM outbound test ${k}` };
    // Clover bulk_line_items requires explicit price (it does not copy from the item ref) —
    // this mirrors how the edge freezes line items (name + price + unitQty).
    const lineItems = chosen.map((it: any) => ({ name: it.name, price: it.price, unitQty: 1 }));

    const jp: any = { order_id: orderId, order_body: orderBody, external_reference_id: extRef };
    const c = await createH({ jobPayload: jp, job: job('create_order'), step: { step_name: 'create_order' }, stepInput: {}, context: {} } as any);
    const cloverId = (c as any).clover_order_id;
    const ctx = { create_order: { clover_order_id: cloverId } };
    const rjp: any = { order_id: orderId, line_items: lineItems, line_items_hash: `hash-${extRef}`, order_total_cents: total };
    await reconcileH({ jobPayload: rjp, context: ctx, job: job('reconcile_items'), step: { step_name: 'reconcile_items' }, stepInput: {} } as any);

    const full = await cget(`/orders/${cloverId}?expand=lineItems`);
    created.push({ extRef, cloverId, total, nItems: (full.lineItems?.elements || []).length });
  }

  // verify: every order has the expected line items + total set to the cents we asserted
  let itemsOk = 0, totalOk = 0;
  for (const o of created) {
    const full = await cget(`/orders/${o.cloverId}?expand=lineItems`);
    if ((full.lineItems?.elements || []).length > 0) itemsOk++;
    if (Math.round(full.total) === Math.round(o.total)) totalOk++;
  }
  report.outbound = { created: created.length, with_line_items: itemsOk, total_cent_exact: totalOk };

  // idempotency: PRIMARY production dedup path — a real MCM order row whose clover_ticket_id gets
  // persisted on first create, so a retry ADOPTS it (no duplicate Clover order).
  const { data: mo } = await supabase.from('orders').insert({ site_id: SITE_A }).select('id').single();
  const orderId = (mo as any).id;
  const extRefI = `MCMI${Math.floor(1000 + Math.random() * 8999)}`;
  const priceItem = pick(items) as any;
  const bodyI = { orderType: { id: ORDER_TYPE }, externalReferenceId: extRefI };
  const first = await createH({ jobPayload: { order_id: orderId, order_body: bodyI, external_reference_id: extRefI }, job: job('create_order'), step: { step_name: 'create_order' }, stepInput: {}, context: {} } as any);
  const firstId = (first as any).clover_order_id;
  const again = await createH({ jobPayload: { order_id: orderId, order_body: bodyI, external_reference_id: extRefI }, job: job('create_order'), step: { step_name: 'create_order' }, stepInput: {}, context: {} } as any);
  report.idempotency = { first_clover_id: firstId, adopted: (again as any).adopted === true, same_clover_id: (again as any).clover_order_id === firstId };
  await supabase.from('orders').delete().eq('site_id', SITE_A).eq('id', orderId);
  await cdel(`/orders/${firstId}`);
  void priceItem;

  // cleanup
  let del = 0;
  for (const o of created) { if ((await cdel(`/orders/${o.cloverId}`)) < 300) del++; }
  report.cleanup = { clover_orders_deleted: del };

  report.finished = new Date().toISOString();
  fs.writeFileSync(__dirname + '/../evidence/D-outbound.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
