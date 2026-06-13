/* eslint-disable */
// ESCENARIO MCM-origin (secuencia del usuario):
// crear mesa (MCM) -> agregar item -> [Omnivore agrega item] -> sync -> agregar+firear ->
// void item (MCM) -> agregar 3 items -> sync. Snapshot de ambos lados en cada paso.
import { EDGE, mcmOrder, snap, omniAddItem, syncOnce, SITE_ID, PID, MI, sleep } from './harness';

const WAITER = { id: '1111', first_name: 'Carlos', last_name: 'Santos' };
const MGR_PIN = '1116';
// Mesa configurable (default 100) para no chocar con corridas previas
const TABLE = { id: process.env.TABLE_ID || 'cd69ae1c-b8cf-4b66-ab6d-8ee5820135b2', ext: process.env.TABLE_EXT || '100' };

async function unfiredIds(orderId: number): Promise<string[]> {
  const o = await mcmOrder(orderId);
  // Firear = todo lo que NO está sent/voided y NO tiene ya un omnivore.item_id (como el app real)
  return (o?.line_items ?? [])
    .filter((i: any) => i.status !== 'sent' && i.status !== 'voided' && !i.additional_properties?.omnivore?.item_id)
    .map((i: any) => i.id);
}
async function fireAllUnfired(orderId: number) {
  const ids = await unfiredIds(orderId);
  if (!ids.length) { console.log('   (nothing to fire)'); return null; }
  const r = await EDGE('send-to-kitchen', { order_id: orderId, site_id: SITE_ID, line_item_ids: ids, employee: WAITER });
  if (!r?.ok) console.log('   send-to-kitchen ERR:', JSON.stringify(r).slice(0, 300));
  return r;
}

(async () => {
  console.log('============ ESCENARIO MCM-ORIGIN ============');

  // 1. Abrir mesa desde MCM → crea ticket en Omnivore
  const open = await EDGE('open-table-order', { site_id: SITE_ID, table_id: TABLE.id, guests: 2, employee: WAITER });
  const orderId = open?.order?.id;
  if (!orderId) { console.log('open-table-order FAILED', JSON.stringify(open).slice(0, 400)); process.exit(1); }
  console.log(`open-table-order → order ${orderId}, pos_id=${open?.order?.pos_id ?? '-'}, warning=${open?.pos_warning ?? '-'}`);
  await snap('1. Mesa abierta (MCM crea ticket Omnivore)', orderId);

  // 2. Agregar item (Guac) desde MCM — sin firear
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.guac, quantity: 1 }] });
  await snap('2. MCM agrega Guac (sin firear)', orderId);

  // 3. Firear (send-to-kitchen) → debe aparecer en Omnivore
  await fireAllUnfired(orderId);
  await snap('3. MCM firea Guac → Omnivore', orderId);

  // 4. Omnivore agrega un item (Elote) directo en el terminal
  const o3 = await mcmOrder(orderId);
  const ticketId = o3?.pos_id as string;
  if (ticketId) { const ok = await omniAddItem(ticketId, MI.elote); console.log('   omniAddItem Elote ok=', ok); }
  await snap('4. Omnivore agrega Elote (PRE-sync)', orderId, ticketId);

  // 5. Sync Omnivore→MCM (merge)
  console.log('   sync:', JSON.stringify(await syncOnce(SITE_ID)));
  await snap('5. Tras sync (merge: Guac fireado + Elote de Omnivore)', orderId);

  // 6. MCM agrega Sopesitos + firea
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.sopes, quantity: 1 }] });
  await fireAllUnfired(orderId);
  await snap('6. MCM agrega+firea Sopesitos', orderId);

  // 7. Void de un item fireado desde MCM (el Guac) → debe anular en Omnivore
  const o6 = await mcmOrder(orderId);
  const guacLine = (o6?.line_items ?? []).find((i: any) => i.name?.includes('Guac') && i.status === 'sent');
  if (guacLine) {
    const vr = await EDGE('void-line-item', { order_id: orderId, site_id: SITE_ID, line_item_id: guacLine.id, reason: 'test void', employee: WAITER, manager_pin: MGR_PIN });
    console.log('   void ok=', vr?.ok, vr?.warning ? `warning=${vr.friendly_error}` : '', vr?.error ?? '');
  } else console.log('   (no fired Guac line to void)');
  await snap('7. MCM void Guac (fireado) → Omnivore', orderId);

  // 8. MCM agrega 3 items + firea
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.chips, quantity: 1 }, { product_id: PID.elote, quantity: 1 }, { product_id: PID.sopes, quantity: 1 }] });
  await fireAllUnfired(orderId);
  await snap('8. MCM agrega+firea 3 items', orderId);

  // 9. Sync final
  console.log('   sync:', JSON.stringify(await syncOnce(SITE_ID)));
  await snap('9. FINAL tras sync', orderId);

  console.log(`\n>>> orderId=${orderId} ticketId=${ticketId} (para cleanup)`);
  process.exit(0);
})().catch((e) => { console.error('SCENARIO ERR', e); process.exit(1); });
