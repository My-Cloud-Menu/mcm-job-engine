/* eslint-disable */
// Verificación de F3 (total estable add↔sync) y F4 (anti-churn: sync sin cambios salta la orden).
import { EDGE, mcmOrder, syncOnce, SITE_ID, PID } from './harness';
const WAITER = { id: '1111', first_name: 'Carlos', last_name: 'Santos' };
const TABLE = { id: '608e1e39-7e4d-4b25-bcaf-9fc853243ab4', ext: '101' }; // mesa 101

async function unfiredIds(orderId: number) {
  const o = await mcmOrder(orderId);
  return (o?.line_items ?? []).filter((i: any) => i.status !== 'sent' && i.status !== 'voided' && !i.additional_properties?.omnivore?.item_id).map((i: any) => i.id);
}

(async () => {
  console.log('============ VERIFICACIÓN F3 + F4 ============');
  const open = await EDGE('open-table-order', { site_id: SITE_ID, table_id: TABLE.id, guests: 2, employee: WAITER });
  const orderId = open?.order?.id;
  if (!orderId) { console.log('open FAIL', JSON.stringify(open).slice(0, 300)); process.exit(1); }

  // Firear un Guac (Omnivore queda con ítems → se activa el path de merge con totales de Omnivore)
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.guac, quantity: 1 }] });
  await EDGE('send-to-kitchen', { order_id: orderId, site_id: SITE_ID, line_item_ids: await unfiredIds(orderId), employee: WAITER });

  // Agregar un Elote SIN firear → add-products recalcula con tax
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.elote, quantity: 1 }] });
  const afterAdd = await mcmOrder(orderId);
  console.log(`\nF3 · tras ADD (Elote sin firear): total=${afterAdd.total}  tax=${afterAdd.total_tax}`);

  // Sync → con F3 el total debe quedar IGUAL (antes bajaba por perder el tax del no-firado)
  const s1 = await syncOnce(SITE_ID);
  const afterSync = await mcmOrder(orderId);
  console.log(`F3 · tras SYNC:                 total=${afterSync.total}  tax=${afterSync.total_tax}   (sync ${JSON.stringify(s1)})`);
  const diff = Math.abs(Number(afterAdd.total) - Number(afterSync.total));
  console.log(diff <= 0.02 ? `   ✅ F3 estable (Δtotal=${diff.toFixed(2)})` : `   ⚠️ F3 fluctúa Δtotal=${diff.toFixed(2)}`);

  // F4: segundo sync SIN cambios → la orden debe quedar en `skipped`, no `updated`
  const s2 = await syncOnce(SITE_ID);
  console.log(`\nF4 · sync #2 sin cambios: ${JSON.stringify(s2)}`);
  const s3 = await syncOnce(SITE_ID);
  console.log(`F4 · sync #3 sin cambios: ${JSON.stringify(s3)}`);
  console.log(`   ${s3.updated === 0 ? '✅' : '⚠️'} updated en sync sin cambios = ${s3.updated} (esperado 0 / bajo)`);

  console.log(`\n>>> orderId=${orderId} ticketId=${afterSync?.pos_id}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
