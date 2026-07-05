/* POS render contract verification — creates a Clover order, pulls it, and checks the MCM
 * order row has valid values for every column/field that /pos-order renders
 * (usePosTicketPanel ORDER_SELECT + orders-store mapOrderToCardProps + PosLineItem).
 * Run: npx tsx docs/clover-bidi/scripts/J-pos-render.ts
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

// Columns the POS ticket panel + live-orders card actually read.
const POS_COLUMNS = ['id', 'site_id', 'status', 'payment_status', 'line_items', 'total', 'subtotal', 'discount_total', 'fee_total', 'total_tax', 'paid', 'customer', 'experience', 'experience_reference', 'date_created', 'date_updated', 'employee', 'table', 'table_id', 'check_number', 'tax_lines', 'fee_lines', 'channel', 'clover_pos_id', 'clover_ticket_id'];

async function main() {
  const report: any = { started: new Date().toISOString() };
  const items = ((await cget('/items?limit=100')).elements || []).filter((i: any) => i.price > 0);
  const chosen = [items[0], items[1], items[2]];
  const total = chosen.reduce((s: number, it: any) => s + it.price, 0);
  const o = (await cpost('/orders', { orderType: { id: ORDER_TYPE }, note: 'POS render test', clientCreatedTime: Date.now(), state: 'open' })).j;
  await cpost(`/orders/${o.id}/bulk_line_items`, { items: chosen.map((it: any) => ({ name: it.name, price: it.price, unitQty: 1 })) });
  await cpost(`/orders/${o.id}`, { total });

  const h = getHandler('clover', 'fetch_open_orders')!;
  await h({ stepInput: { schedule_id: SCH_OPEN, cursor: null }, jobPayload: {}, context: {}, job: { id: 'j', site_id: SITE_A, correlation_id: 'pos-render', integration: 'clover', queue_name: 'pos_sync', job_type: 'fetch_open_orders' } as any, step: { step_name: 'fetch_open_orders' } as any } as any);

  const { data: row } = await supabase.from('orders').select(POS_COLUMNS.join(',')).eq('site_id', SITE_A).eq('clover_pos_id', o.id).maybeSingle();
  report.order_found = !!row;
  if (row) {
    const r: any = row;
    const isNum = (v: any) => typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));
    const checks: Record<string, any> = {};
    for (const c of POS_COLUMNS) checks[c] = { present: r[c] !== undefined && r[c] !== null, value_type: Array.isArray(r[c]) ? 'array' : typeof r[c] };
    // POS render-critical assertions
    report.render_checks = {
      channel_is_pos: r.channel === 'pos',
      status_present: !!r.status,
      payment_status_present: !!r.payment_status,
      totals_numeric: ['total', 'subtotal', 'total_tax', 'paid'].every((k) => isNum(r[k])),
      line_items_array: Array.isArray(r.line_items) && r.line_items.length === 3,
      clover_id_surfaced: (r.clover_pos_id || r.clover_ticket_id) === o.id,
      tax_lines_present: Array.isArray(r.tax_lines),
      experience_present: !!r.experience,
      date_fields: !!r.date_created && !!r.date_updated,
    };
    // line item shape (PosLineItem: id,name,price,quantity,total, product_id, additional_properties)
    const li = (r.line_items || [])[0] || {};
    report.line_item_shape = {
      has_id: li.id !== undefined, has_name: !!li.name, price_numeric: isNum(li.price),
      has_quantity: li.quantity !== undefined, has_total: isNum(li.total),
      product_id_value: li.product_id, // NOTE: this is the Clover item id, not an MCM product id
      has_additional_properties: li.additional_properties !== undefined,
      has_modifiers_key: li.additional_properties && 'modifiers' in (li.additional_properties || {}),
      has_attributes: Array.isArray(li.attributes),
    };
    report.column_presence = checks;
  }
  // cleanup
  await supabase.from('orders').delete().eq('site_id', SITE_A).eq('clover_pos_id', o.id);
  await cdel(`/orders/${o.id}`);
  report.finished = new Date().toISOString();
  fs.writeFileSync(__dirname + '/../evidence/J-pos-render.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(1); });
