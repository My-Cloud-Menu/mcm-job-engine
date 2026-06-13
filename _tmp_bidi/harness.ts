/* eslint-disable */
// Harness de pruebas bidireccionales MCM (Order&Pay) <-> Omnivore (Dev, site Carlos Business).
// MCM: HTTP a edge functions desplegadas (service_role). Omnivore: API directa. Sync: código real.
import 'dotenv/config';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { syncOnce } from './sync-once';

const SITE_ID = 55126712;
const SB_URL = process.env.SUPABASE_URL!;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OMNI_BASE = 'https://api.omnivore.io/1.0/locations/cx9oRBRi';
const OMNI_KEY = '909509d093a6408e8704490a29088ced';
const EMP = '975', RC = '20', OT = '0';
const TABLE_10 = { id: '8739d1e3-73fa-4bb0-8db3-3bb23cf3ac09', ext: '10' };
// Omnivore menu_item ids
const MI = { guac: '300020', elote: '300025', sopes: '300055', chips: '300015' };
// MCM product ids
const PID = { guac: 10003, elote: 10004, sopes: 10005, chips: 10002, pizza: 10001 };

const sb = createClient(SB_URL, SRK);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function EDGE(fn: string, body: any) {
  try {
    const { data } = await axios.post(`${SB_URL}/functions/v1/${fn}`, body, {
      headers: { Authorization: `Bearer ${SRK}`, apikey: SRK, 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    return data;
  } catch (e: any) { return { _error: e?.message, _resp: e?.response?.data }; }
}
async function OMNI(method: string, path: string, data?: any, idem?: string) {
  const headers: any = { 'Api-Key': OMNI_KEY };
  if (idem) headers['Idempotency-Id'] = idem;
  const { data: d, status } = await axios.request({
    baseURL: OMNI_BASE, url: path, method, headers, data, validateStatus: () => true,
  });
  return { status, d };
}
async function omniItems(ticketId: string) {
  const { d } = await OMNI('GET', `/tickets/${ticketId}/items`);
  const items = d?._embedded?.items ?? [];
  return items.map((it: any) => ({ id: String(it.id), name: it.name, price: it.price, qty: it.quantity, sent: it.sent }));
}
async function omniTicket(ticketId: string) {
  const { d } = await OMNI('GET', `/tickets/${ticketId}`);
  return { open: d?.open, totals: d?.totals, ticket_number: d?.ticket_number };
}
async function mcmOrder(orderId: number) {
  const { data } = await sb.from('orders').select('id,status,subtotal,total,total_tax,paid,payment_status,pos_id,omnivore_pos_id,line_items,additional_properties,date_updated').eq('id', orderId).eq('site_id', SITE_ID).maybeSingle();
  return data;
}

function fmtMcmItems(li: any[]) {
  return (li ?? []).map((i) => `${i.id}|"${i.name}"|$${i.price}|t${i.total}|${i.status}|oid=${i.additional_properties?.omnivore?.item_id ?? '-'}|org=${i.additional_properties?.omnivore?.origin ?? '-'}`);
}

async function snap(label: string, orderId: number, ticketId?: string | null) {
  console.log(`\n──────── ${label} ────────`);
  const o = await mcmOrder(orderId);
  if (!o) { console.log(`  MCM order ${orderId} NOT FOUND`); }
  else {
    const managed = o.additional_properties?.omnivore_managed === true;
    console.log(`  MCM #${o.id} status=${o.status} managed=${managed} pos_id=${o.pos_id ?? '-'} sub=${o.subtotal} total=${o.total} tax=${o.total_tax} paid=${o.paid} pay=${o.payment_status}`);
    for (const s of fmtMcmItems(o.line_items)) console.log(`     MCM  ${s}`);
  }
  const tid = ticketId ?? (o?.pos_id as string) ?? (o?.omnivore_pos_id as string);
  if (tid) {
    const t = await omniTicket(tid);
    const its = await omniItems(tid);
    console.log(`  OMNI ticket=${tid} #${t.ticket_number} open=${t.open} totals(due=${t.totals?.due} paid=${t.totals?.paid} total=${t.totals?.total} sub=${t.totals?.sub_total ?? t.totals?.subtotal})`);
    for (const it of its) console.log(`     OMNI ${it.id}|"${it.name}"|$${(it.price/100).toFixed(2)}|q${it.qty}|sent=${it.sent}`);
    // ── Consistency flags ──
    const flags: string[] = [];
    const mItems = (o?.line_items ?? []).filter((i: any) => i.status !== 'voided');
    for (const i of mItems) {
      if (!i.name || i.name === '') flags.push(`EMPTY_NAME ${i.id}`);
      if (i.price === '0.00' || i.price === '0' || Number(i.price) === 0) {
        // 0-price legit only if product price is 0; flag as suspect
        flags.push(`ZERO_PRICE ${i.id} "${i.name}"`);
      }
      const oid = i.additional_properties?.omnivore?.item_id;
      if (i.status === 'sent' && oid && !its.find((x: any) => x.id === String(oid))) flags.push(`ORPHAN_OID ${i.id} oid=${oid}`);
    }
    const referencedOids = new Set(mItems.flatMap((i: any) => {
      const a = i.additional_properties?.omnivore; const ids = [];
      if (a?.item_id) ids.push(String(a.item_id)); if (Array.isArray(a?.item_ids)) ids.push(...a.item_ids.map(String)); return ids;
    }));
    for (const it of its) if (!referencedOids.has(it.id)) flags.push(`OMNI_UNSYNCED ${it.id} "${it.name}"`);
    if (flags.length) console.log(`  ⚠️  FLAGS: ${flags.join(' ; ')}`);
    else console.log(`  ✅ consistent (mcm active items ${mItems.length} ↔ omni items ${its.length})`);
  }
  return o;
}

// Crea ticket directo en Omnivore (simula mesero en el terminal)
async function omniCreateTicket(name: string, table?: string) {
  const body: any = { employee: EMP, order_type: OT, revenue_center: RC, name, auto_send: false };
  if (table) body.table = table;
  const { status, d } = await OMNI('POST', '/tickets', body, `test_open:${name}:${Date.now()}`);
  if (!d?.id) { console.log('  omniCreateTicket FAIL', status, JSON.stringify(d?.errors ?? d).slice(0, 300)); return null; }
  return String(d.id);
}
async function omniAddItem(ticketId: string, menuItem: string, qty = 1) {
  const body = { items: [{ menu_item: menuItem, quantity: qty, item_order_mode: OT, auto_send: true }] };
  const { status, d } = await OMNI('POST', `/tickets/${ticketId}/items`, body, `test_add:${ticketId}:${menuItem}:${Date.now()}`);
  const ok = status >= 200 && status < 300;
  if (!ok) console.log('  omniAddItem FAIL', status, JSON.stringify(d?.errors ?? d).slice(0, 300));
  return ok;
}

export { sb, EDGE, OMNI, omniItems, omniTicket, mcmOrder, snap, omniCreateTicket, omniAddItem, syncOnce, SITE_ID, TABLE_10, PID, MI, EMP, sleep };
