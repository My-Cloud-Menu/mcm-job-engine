/* eslint-disable */
// P0 · Cantidad > 1 (Aloha parte qty=N en N filas → correlación multi item_id en MCM).
import { EDGE, mcmOrder, snap, omniItems, omniAddItem, syncOnce, SITE_ID, PID, MI } from './harness';
const WAITER = { id: '1111', first_name: 'Carlos', last_name: 'Santos' };
const TABLE = { id: 'cd69ae1c-b8cf-4b66-ab6d-8ee5820135b2', ext: '100' };

async function unfiredIds(orderId: number) {
  const o = await mcmOrder(orderId);
  return (o?.line_items ?? []).filter((i: any) => i.status !== 'sent' && i.status !== 'voided' && !i.additional_properties?.omnivore?.item_id).map((i: any) => i.id);
}
function dumpMcmOids(o: any) {
  for (const li of o?.line_items ?? []) {
    const om = li.additional_properties?.omnivore ?? {};
    console.log(`   MCM ${li.id} "${li.name}" qty=${li.quantity} status=${li.status} item_id=${om.item_id ?? '-'} item_ids=${JSON.stringify(om.item_ids ?? null)} origin=${om.origin ?? '-'}`);
  }
}

(async () => {
  console.log('============ P0 · CANTIDAD > 1 ============');
  const open = await EDGE('open-table-order', { site_id: SITE_ID, table_id: TABLE.id, guests: 2, employee: WAITER });
  const orderId = open?.order?.id; if (!orderId) { console.log('open FAIL', JSON.stringify(open).slice(0,300)); process.exit(1); }
  const ticketId = open.order.pos_id;

  // 1. MCM agrega Elote qty=3 + firea → ¿Omnivore lo parte en 3 filas? ¿MCM correlaciona item_ids[3]?
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.elote, quantity: 3 }] });
  await EDGE('send-to-kitchen', { order_id: orderId, site_id: SITE_ID, line_item_ids: await unfiredIds(orderId), employee: WAITER });
  let o = await mcmOrder(orderId);
  let its = await omniItems(ticketId);
  console.log(`\n[1] MCM agrega Elote qty=3 + firea`);
  console.log(`   Omnivore filas: ${its.length} → ${JSON.stringify(its.map((i:any)=>({id:i.id,name:i.name,q:i.qty})))}`);
  dumpMcmOids(o);
  const eloteLine = (o?.line_items ?? []).find((l:any)=>l.name?.includes('Elote'));
  const nOids = (eloteLine?.additional_properties?.omnivore?.item_ids ?? (eloteLine?.additional_properties?.omnivore?.item_id ? [eloteLine.additional_properties.omnivore.item_id] : [])).length;
  console.log(`   → MCM línea Elote tiene ${nOids} item_id(s) para qty=3 (Omnivore tiene ${its.filter((i:any)=>i.name?.includes('Elote')).length} filas Elote)`);

  // 2. Omnivore agrega Guac qty=2 → sync → ¿cómo lo representa MCM?
  await omniAddItem(ticketId, MI.guac, 2);
  console.log('\n[2] Omnivore agrega Guac qty=2 → sync');
  console.log('   sync:', JSON.stringify(await syncOnce(SITE_ID)));
  o = await mcmOrder(orderId); its = await omniItems(ticketId);
  console.log(`   Omnivore filas: ${its.length}`);
  dumpMcmOids(o);

  // 3. Consistencia final
  await snap('[3] FINAL', orderId, ticketId);
  console.log(`\n>>> orderId=${orderId} ticketId=${ticketId}`);
  process.exit(0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
