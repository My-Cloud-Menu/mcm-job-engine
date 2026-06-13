/* eslint-disable */
// ESCENARIO Omnivore-origin: ticket creado PRIMERO en Omnivore (mesero en terminal) ->
// sync -> MCM. ¿Se marca managed? ¿Se puede editar/firear desde MCM? -> merge bidireccional.
import { EDGE, sb, mcmOrder, snap, omniCreateTicket, omniAddItem, syncOnce, SITE_ID, PID, MI } from './harness';

const WAITER = { id: '1111', first_name: 'Carlos', last_name: 'Santos' };
const TABLE_EXT = process.env.TABLE_EXT || '101';

async function findOrderByTicket(ticketId: string): Promise<number | null> {
  const { data } = await sb.from('orders').select('id').eq('site_id', SITE_ID).eq('omnivore_pos_id', ticketId).maybeSingle();
  return data?.id ?? null;
}
async function unfiredIds(orderId: number): Promise<string[]> {
  const o = await mcmOrder(orderId);
  return (o?.line_items ?? []).filter((i: any) => i.status !== 'sent' && i.status !== 'voided' && !i.additional_properties?.omnivore?.item_id).map((i: any) => i.id);
}

(async () => {
  console.log('============ ESCENARIO OMNIVORE-ORIGIN ============');
  // 1. Crear ticket en Omnivore CON mesa (experience=qe) + 2 items
  const name = `OMNI-${Date.now() % 100000}`;
  const ticketId = await omniCreateTicket(name, TABLE_EXT);
  if (!ticketId) { console.log('omniCreateTicket FAILED'); process.exit(1); }
  await omniAddItem(ticketId, MI.guac);
  await omniAddItem(ticketId, MI.elote);
  console.log(`Omnivore ticket ${ticketId} con Guac+Elote (mesa ${TABLE_EXT})`);

  // 2. Sync → MCM
  console.log('   sync:', JSON.stringify(await syncOnce(SITE_ID)));
  const orderId = await findOrderByTicket(ticketId);
  if (!orderId) { console.log('❌ NO se creó orden MCM para el ticket', ticketId); process.exit(1); }
  const o1 = await snap('1. Tras sync — orden creada desde Omnivore', orderId, ticketId);
  console.log(`   >>> managed=${o1?.additional_properties?.omnivore_managed === true}  experience=${(await mcmOrder(orderId))?.['experience'] ?? '?'}`);

  // 3. Desde MCM: agregar Sopesitos + firear (¿funciona sobre orden de origen Omnivore?)
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.sopes, quantity: 1 }] });
  await snap('2. MCM agrega Sopesitos (sin firear)', orderId, ticketId);
  const ids = await unfiredIds(orderId);
  const fr = await EDGE('send-to-kitchen', { order_id: orderId, site_id: SITE_ID, line_item_ids: ids, employee: WAITER });
  console.log('   fire ok=', fr?.ok, fr?.error ?? '');
  await snap('3. MCM firea Sopesitos → Omnivore', orderId, ticketId);

  // 4. Omnivore agrega Chips → sync → merge
  await omniAddItem(ticketId, MI.chips);
  console.log('   sync:', JSON.stringify(await syncOnce(SITE_ID)));
  await snap('4. Omnivore agrega Chips → sync (merge)', orderId, ticketId);

  console.log(`\n>>> orderId=${orderId} ticketId=${ticketId}`);
  process.exit(0);
})().catch((e) => { console.error('SCENARIO ERR', e); process.exit(1); });
