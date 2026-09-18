// E2E del MOTOR sobre el banco (site 25612612), SIN worker en la cola: llama a `upsertOmnivoreOrders`
// (código nuevo) directamente. Dos comprobaciones:
//   A) fire EN VUELO → el upsert SALTA la orden (skipped=1, ningún cambio).
//   B) fire "muerto" entre POST y estampa (simulado: ítem en el ticket + línea con fire_pending_at +
//      in_flight_until expirado) → el merge ADOPTA el ítem (1 línea, sent, item_id) en vez de duplicar.
// Uso (cwd = mcm-job-engine): npx tsx _e2e-omnivore-fire-upsert.ts
import './src/config';
import { getSiteIntegrationConfig } from './src/lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from './src/handlers/omnivore/client';
import { upsertOmnivoreOrders } from './src/handlers/omnivore/sync/upsert-orders';
import { supabase } from './src/lib/supabase';
// @ts-ignore — helpers del E2E del edge (ESM JS)
import { edge, getOrder, omni, uuid, EMPLOYEE, SITE_ID, classify, login, env } from '../mcm-edge-functions/audits/2026-09-18-omnivore-fire-before-pay/e2e/lib.mjs';
import { writeFileSync } from 'node:fs';

async function main() {
const TABLE_ID = process.env.TABLE_ID; if (!TABLE_ID) throw new Error('TABLE_ID requerido');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rec: any = { t0: new Date().toISOString() };
await login();
const { config } = await getSiteIntegrationConfig(SITE_ID, 'omnivore', 'pos');
const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), 'e2e-fire');
const fetchTicket = async (id: string) => (await client.get(`/tickets/${id}`, { params: { fields: 'id,name,open,opened_at,closed_at,totals(due,paid,items,discounts,service_charges,tax,total),employee(id,first_name,last_name),order_type(id,name),revenue_center(id,name),table(id,name),items(id,sent,sent_at,name,comment,price,quantity,modifiers(id,name,price,quantity,comment,menu_modifier(id,pos_id),modifier_group(id,pos_id,name)),menu_item(id,menu_categories(id)))' } })).data;

// ── A) fire en vuelo → skip ──
const openA = await edge('open-table-order', { location_id: 90010040, table_id: TABLE_ID, guests: 2, employee: EMPLOYEE, device_id: 'QA-E2E', idempotency_key: uuid() });
const idA = openA.body?.order?.id; const ticketA = openA.body?.order?.pos_id;
await edge('add-products-to-order', { order_id: idA, line_items: [{ product_id: 10135, quantity: 1 }, { product_id: 10134, quantity: 1 }], employee: EMPLOYEE, idempotency_key: uuid() });
const o1 = await getOrder(idA); const ids = (o1.line_items ?? []).map((li: any) => li.id);
const fireP = edge('send-to-kitchen-canary', { order_id: idA, line_item_ids: ids, employee: EMPLOYEE, expected_date_updated: o1.date_updated, idempotency_key: `stk:${SITE_ID}:${idA}:${[...ids].sort().join(',')}` });
await sleep(1200); // el POST al POS suele estar en vuelo aquí; la fase 0 ya escribió el marcador
const fetchStartIso = new Date().toISOString();
const tA = await fetchTicket(ticketA);
const mid = await getOrder(idA);
const rA = await upsertOmnivoreOrders(SITE_ID, [tA], config, fetchStartIso);
rec.A = { in_flight_at_upsert: classify(mid).fire, ticket_items_at_upsert: (tA?._embedded?.items ?? []).length, upsert: rA, afterUpsert: classify(await getOrder(idA)) };
const fire = await fireP; rec.A.fire = { status: fire.status, err: fire.body?.error };
await sleep(500);
const rA2 = await upsertOmnivoreOrders(SITE_ID, [await fetchTicket(ticketA)], config, new Date().toISOString());
rec.A.upsertAfterFire = rA2; rec.A.final = classify(await getOrder(idA));
console.log('A) en vuelo → upsert', JSON.stringify(rA), 'ticketItems', rec.A.ticket_items_at_upsert, '| fire', rec.A.fire.status, '| tras fire upsert', JSON.stringify(rA2), '| final', JSON.stringify({ live: rec.A.final.live, unfired: rec.A.final.unfired, posAdd: rec.A.final.posAdd, mcmStamped: rec.A.final.mcmStamped, dup: rec.A.final.dup }));

// ── B) crash simulado entre POST y estampa → adopción ──
const openB = await edge('open-table-order', { location_id: 90010040, table_id: TABLE_ID, guests: 2, employee: EMPLOYEE, device_id: 'QA-E2E', idempotency_key: uuid() });
const idB = openB.body?.order?.id; const ticketB = openB.body?.order?.pos_id;
await edge('add-products-to-order', { order_id: idB, line_items: [{ product_id: 10135, quantity: 1 }], employee: EMPLOYEE, idempotency_key: uuid() });
const oB = await getOrder(idB);
// 1) el POST "aterrizó" en el POS (lo hacemos a mano, como haría el fire justo antes de morir)
const posted = await client.post(`/tickets/${ticketB}/items`, { items: [{ menu_item: '305114', quantity: 1, auto_send: true }] });
const tbItems = (posted.data?._embedded?.items ?? []).map((i: any) => i.id);
// 2) la línea quedó marcada por la fase 0 y el marcador de orden ya expiró (fire muerto)
const markedLines = (oB.line_items ?? []).map((li: any) => ({ ...li, additional_properties: { ...(li.additional_properties ?? {}), omnivore: { fire_pending_at: new Date(Date.now() - 30_000).toISOString(), fire_id: 'F-crash' } } }));
const apB = { ...(oB.additional_properties ?? {}), omnivore_fire: { in_flight_until: new Date(Date.now() - 1000).toISOString(), fire_id: 'F-crash' } };
const { error: wErr } = await supabase.from('orders').update({ line_items: markedLines, additional_properties: apB }).eq('site_id', SITE_ID).eq('id', idB);
if (wErr) throw wErr;
const rB = await upsertOmnivoreOrders(SITE_ID, [await fetchTicket(ticketB)], config, new Date().toISOString());
const fB = await getOrder(idB); const cB = classify(fB);
rec.B = { ticket_item_ids: tbItems, upsert: rB, final: cB, lines: (fB.line_items ?? []).map((li: any) => ({ id: li.id.slice(0, 8), status: li.status, omni: li.additional_properties?.omnivore })) };
console.log('B) crash simulado → upsert', JSON.stringify(rB), '| final', JSON.stringify({ live: cB.live, unfired: cB.unfired, posAdd: cB.posAdd, mcmStamped: cB.mcmStamped, dup: cB.dup }), '| líneas', JSON.stringify(rec.B.lines));
rec.orders = { A: idA, B: idB };
const file = `../mcm-edge-functions/audits/2026-09-18-omnivore-fire-before-pay/evidencia/motor-upsert-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(rec, null, 1)); console.log('evidencia →', file);
}
main().then(() => process.exit(0)).catch((e) => { console.error('E2E motor falló:', e?.message ?? e); process.exit(1); });
