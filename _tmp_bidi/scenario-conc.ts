/* eslint-disable */
// P0 · Concurrencia/carreras. B1: ítem sin firear sobrevive un sync. B2: guard de frescura
// (un fire DESPUÉS del fetch del sync no debe ser pisado por el snapshot viejo). B3: edits rápidos.
import { EDGE, mcmOrder, snap, syncOnce, SITE_ID, PID } from './harness';
import { getSiteIntegrationConfig } from '../src/lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../src/handlers/omnivore/client';
import { fetchOmnivoreOrders } from '../src/handlers/omnivore/sync/order-mapper';
import { upsertOmnivoreOrders } from '../src/handlers/omnivore/sync/upsert-orders';

const WAITER = { id: '1111', first_name: 'Carlos', last_name: 'Santos' };
const TABLE = { id: '608e1e39-7e4d-4b25-bcaf-9fc853243ab4', ext: '101' };
const names = (o:any) => (o?.line_items??[]).map((l:any)=>`${l.name}(${l.status ?? 'new'})`).join(', ');
async function unfiredIds(orderId: number) {
  const o = await mcmOrder(orderId);
  return (o?.line_items ?? []).filter((i: any) => i.status !== 'sent' && i.status !== 'voided' && !i.additional_properties?.omnivore?.item_id).map((i: any) => i.id);
}

(async () => {
  console.log('============ P0 · CONCURRENCIA ============');
  const open = await EDGE('open-table-order', { site_id: SITE_ID, table_id: TABLE.id, guests: 2, employee: WAITER });
  const orderId = open?.order?.id; if (!orderId) { console.log('open FAIL', JSON.stringify(open).slice(0,300)); process.exit(1); }

  // ── B1: ítem SIN FIREAR sobrevive un sync ──────────────────────────────────
  console.log('\n[B1] agrego 2 ítems SIN firear, corro sync, verifico que sobreviven');
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.elote, quantity: 1 }] });
  await EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.sopes, quantity: 1 }] });
  const beforeB1 = await mcmOrder(orderId);
  console.log(`   antes de sync: [${names(beforeB1)}]`);
  await syncOnce(SITE_ID);
  const afterB1 = await mcmOrder(orderId);
  console.log(`   después de sync: [${names(afterB1)}]`);
  const b1ok = (afterB1?.line_items?.length ?? 0) >= 2 && (afterB1?.line_items ?? []).every((l:any)=>l.name && Number(l.price)>0);
  console.log(`   ${b1ok ? '✅' : '⚠️'} B1: ítems sin firear ${b1ok ? 'PRESERVADOS' : 'PERDIDOS/CORRUPTOS'}`);

  // ── B2: GUARD DE FRESCURA. fetch (T0) → fire (T1>T0) → upsert(snapshot viejo, T0) ──
  console.log('\n[B2] guard de frescura: un fire DESPUÉS del fetch del sync no debe ser pisado');
  const { config } = await getSiteIntegrationConfig(SITE_ID, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), 'conc');
  const T0 = new Date().toISOString();                       // fetchStartIso del sync "viejo"
  const [recent, openT] = await Promise.all([fetchOmnivoreOrders(client,'today'), fetchOmnivoreOrders(client,'open')]);
  const byId = new Map<string,any>(); for (const x of [...recent,...openT]) if (x?.id) byId.set(String(x.id), x);
  const staleSnapshot = [...byId.values()];                  // snapshot SIN el fire que viene
  // Ahora el mesero FIREA (escribe omnivore_synced_at > T0 + mete el ítem en Omnivore)
  await EDGE('send-to-kitchen', { order_id: orderId, site_id: SITE_ID, line_item_ids: await unfiredIds(orderId), employee: WAITER });
  const afterFire = await mcmOrder(orderId);
  console.log(`   tras fire: [${names(afterFire)}]  synced_at=${afterFire?.additional_properties?.omnivore_synced_at}`);
  // El sync VIEJO termina (upsert con el snapshot viejo + T0). El guard debe SALTAR esta orden.
  const res = await upsertOmnivoreOrders(SITE_ID, staleSnapshot, config, T0);
  console.log(`   upsert(snapshot viejo): ${JSON.stringify(res)}`);
  const afterStale = await mcmOrder(orderId);
  console.log(`   tras upsert viejo: [${names(afterStale)}]`);
  const firedCount = (afterStale?.line_items??[]).filter((l:any)=>l.status==='sent').length;
  const b2ok = firedCount >= 2; // los 2 ítems fireados deben seguir 'sent' (no revertidos a new ni perdidos)
  console.log(`   ${b2ok ? '✅' : '⚠️'} B2: el fire ${b2ok ? 'NO fue pisado por el snapshot viejo (guard OK)' : 'FUE PISADO (guard falla)'}`);

  // ── B3: edits rápidos en sucesión sin esperar ──────────────────────────────
  console.log('\n[B3] 3 add-products rápidos en paralelo (sin esperar entre sí)');
  await Promise.all([
    EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.chips, quantity: 1 }], idempotency_key: `b3-chips-${orderId}` }),
    EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.guac, quantity: 1 }], idempotency_key: `b3-guac-${orderId}` }),
    EDGE('add-products-to-order', { order_id: orderId, site_id: SITE_ID, line_items: [{ product_id: PID.elote, quantity: 1 }], idempotency_key: `b3-elote2-${orderId}` }),
  ]);
  const afterB3 = await mcmOrder(orderId);
  console.log(`   tras 3 adds paralelos: ${afterB3?.line_items?.length} ítems [${names(afterB3)}]`);
  console.log(`   (nota: con CAS, adds concurrentes pueden colisionar → algunos 409; ver cuántos quedaron)`);

  await snap('[FINAL]', orderId);
  console.log(`\n>>> orderId=${orderId} ticketId=${open.order.pos_id}`);
  process.exit(0);
})().catch(e=>{console.error('ERR',e);process.exit(1);});
