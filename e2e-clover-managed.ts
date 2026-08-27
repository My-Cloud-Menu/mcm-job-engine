/**
 * E2E del modo gestionado de Clover, contra el merchant sandbox REAL.
 *
 * Ejercita el código LOCAL (no el dist desplegado) llamando a los handlers directo,
 * igual que hace e2e-clover.ts. El site 99990004 tiene sus schedules pausados para que
 * el worker remoto —que corre el dist viejo— no interfiera.
 *
 * Nada de Omnivore se toca: sólo handlers `clover.*` y sólo el site 99990004.
 */
import './src/handlers/clover/inject/create-order';
import './src/handlers/clover/inject/reconcile-items';
import { getHandler } from './src/handlers/registry';
import { upsertOrdersFromClover } from './src/handlers/clover/sync/upsert-orders';
import { cloverIdsOf } from './src/handlers/clover/sync/managed-merge';
import { getSiteIntegrationConfig } from './src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from './src/handlers/clover/client';
import { supabase } from './src/lib/supabase';

const SITE = 99990004;
// OJO: `orders` tiene el trigger BEFORE INSERT `on_create_new_orders` -> `trigger_generate_id()`,
// que SOBRESCRIBE el id que le pases. Hay que insertar sin id y leer el asignado.
let ORDER_ID = 0;
const job: any = { id: 'e2e-managed', site_id: SITE, correlation_id: 'e2e' };
const step: any = { idempotency_key: 'e2e', attempt_count: 0, max_attempts: 3 };

const ok: string[] = [];
const bad: string[] = [];
const check = (nombre: string, cond: boolean, detalle = '') => {
  (cond ? ok : bad).push(`${cond ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
  console.log(`${cond ? '  ✓' : '  ✗'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
};

const li = (id: string, product_id: string, name: string, price: string, qty = 1) => ({
  id, product_id, name, price, quantity: qty, notes: '', status: 'new',
  total: (Number(price) * qty).toFixed(2), tax_class: 'standard', attributes: [],
  additional_properties: {},
});
/** línea en forma Clover (lo que el edge congela en el payload) */
const clv = (name: string, cents: number) => ({ name, price: cents });

async function main() {
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cfg = CloverConfigSchema.parse(config);
  const client = createCloverClient(cfg, 'e2e');
  console.log(`\nmerchant=${cfg.merchantId}  url=${cfg.apiUrl}\n`);

  // ── 1. orden en MCM con 2 líneas ─────────────────────────────────────────
  const lineas = [li('u1', '500', 'Café', '2.50'), li('u2', '600', 'Tostada', '4.00')];
  const { data: nueva, error: insErr } = await supabase.from('orders').insert({
    site_id: SITE, channel: 'pos', status: 'new-order', payment_status: 'not_fulfilled',
    currency: 'USD', line_items: lineas, subtotal: 6.5, total: 6.5, total_tax: 0, paid: 0,
    discount_total: 0, shipping_total: 0, fee_total: 0, additional_properties: {},
    date_created: new Date().toISOString(), date_updated: new Date().toISOString(),
  }).select('id').single();
  if (insErr) throw new Error('insert orden: ' + JSON.stringify(insErr));
  ORDER_ID = Number((nueva as any).id);
  console.log(`1) orden MCM ${ORDER_ID} creada con 2 líneas (id asignado por trigger)`);

  // ── 2. push inicial ──────────────────────────────────────────────────────
  const createOrder = getHandler('clover', 'create_order')!;
  const reconcile = getHandler('clover', 'reconcile_items')!;
  const externalRef = `e2e${Math.random().toString(36).slice(2, 10)}`;

  const c1: any = await createOrder({
    jobPayload: { order_id: ORDER_ID, external_reference_id: externalRef,
      order_body: { title: 'E2E Managed', state: 'Open', currency: 'USD', externalReferenceId: externalRef } },
    context: {}, job, step,
  } as any);
  const cloverOrderId = c1.clover_order_id;
  console.log(`2) orden Clover ${cloverOrderId}  externalRef=${externalRef}  adoptada=${!!c1.adopted}`);
  check('create_order NO adopta una orden ajena', !c1.adopted, c1.adopted ? 'ADOPTÓ una previa' : 'creada nueva');

  const deseadas1 = [clv('Café', 250), clv('Tostada', 400)];
  const r1: any = await reconcile({
    jobPayload: { order_id: ORDER_ID, line_items: deseadas1, line_items_hash: 'H1', order_total_cents: 650 },
    context: { create_order: { clover_order_id: cloverOrderId } }, job, step,
  } as any);
  check('push inicial crea las 2 líneas', r1.added === 2 && r1.removed === 0, JSON.stringify(r1));

  const leerClover = async () => {
    const r = await client.get<any>(`/orders/${cloverOrderId}?expand=lineItems,lineItems.taxRates,lineItems.modifications,payments`);
    return (r.data?.lineItems?.elements ?? []) as any[];
  };
  const idsTras1 = (await leerClover()).map((l) => l.id).sort();
  check('Clover tiene 2 líneas', idsTras1.length === 2, idsTras1.join(','));

  // ── 3. A9: añadir 1 ítem NO debe recrear las otras 2 ─────────────────────
  const deseadas2 = [...deseadas1, clv('Zumo', 300)];
  const r2: any = await reconcile({
    jobPayload: { order_id: ORDER_ID, line_items: deseadas2, line_items_hash: 'H2', order_total_cents: 950 },
    context: { create_order: { clover_order_id: cloverOrderId } }, job, step,
  } as any);
  check('A9 · edición incremental: conserva 2, crea 1, borra 0',
        r2.kept === 2 && r2.added === 1 && r2.removed === 0, JSON.stringify(r2));

  const trasEdicion = await leerClover();
  const idsTras2 = trasEdicion.map((l) => l.id).sort();
  const sobreviven = idsTras1.filter((id) => idsTras2.includes(id));
  check('A9 · LOS IDS ORIGINALES SOBREVIVEN (el ancla del merge)',
        sobreviven.length === 2, `${sobreviven.length}/2 conservados`);

  // ── 4. pull: el merge ancla las líneas MCM sin duplicar ──────────────────
  const pedirOrden = async () => (await client.get<any>(
    `/orders/${cloverOrderId}?expand=lineItems,lineItems.taxRates,lineItems.modifications,payments`)).data;

  const up1 = await upsertOrdersFromClover(SITE, [await pedirOrden()], { tableServiceEnabled: true });
  console.log('   upsert:', JSON.stringify(up1));
  let { data: o } = await supabase.from('orders').select('line_items, additional_properties').eq('id', ORDER_ID).eq('site_id', SITE).maybeSingle();
  let lis: any[] = (o as any)?.line_items ?? [];
  check('pull · marca la orden como gestionada', (o as any)?.additional_properties?.clover_managed === true);
  check('pull · NO duplica: 3 líneas, no 6', lis.length === 3, `${lis.length} líneas`);
  check('pull · conserva los uuid originales u1 y u2',
        lis.some((l) => l.id === 'u1') && lis.some((l) => l.id === 'u2'),
        lis.map((l) => l.id).join(','));
  check('pull · las ancla con su clover line_item_id',
        lis.filter((l) => cloverIdsOf(l).length > 0).length === 3);

  // ── 5. el terminal añade un ítem ─────────────────────────────────────────
  await client.post(`/orders/${cloverOrderId}/line_items`, { name: 'Postre del terminal', price: 700 });
  await upsertOrdersFromClover(SITE, [await pedirOrden()], { tableServiceEnabled: true });
  ({ data: o } = await supabase.from('orders').select('line_items').eq('id', ORDER_ID).eq('site_id', SITE).maybeSingle());
  lis = (o as any)?.line_items ?? [];
  const delTerminal = lis.find((l) => String(l.name) === 'Postre del terminal');
  check('POS-ADD · lo añadido en el terminal aparece en MCM', !!delTerminal);
  check('POS-ADD · marcado origin=pos', delTerminal?.additional_properties?.clover?.origin === 'pos');
  check('POS-ADD · sin duplicar el resto', lis.length === 4, `${lis.length} líneas`);

  // ── 6. el terminal anula un ítem ─────────────────────────────────────────
  const aBorrar = (await leerClover()).find((l) => l.name === 'Zumo');
  await client.delete(`/orders/${cloverOrderId}/line_items/${aBorrar.id}`);
  await upsertOrdersFromClover(SITE, [await pedirOrden()], { tableServiceEnabled: true });
  ({ data: o } = await supabase.from('orders').select('line_items').eq('id', ORDER_ID).eq('site_id', SITE).maybeSingle());
  lis = (o as any)?.line_items ?? [];
  const zumo = lis.find((l) => String(l.name) === 'Zumo');
  check('TERMINAL-VOID · el ítem anulado en el terminal se marca voided', zumo?.status === 'voided',
        `status=${zumo?.status}`);
  check('TERMINAL-VOID · con su motivo', zumo?.void_reason === 'voided at terminal');

  // ── 7. una línea local sin empujar NO se pierde ──────────────────────────
  const conLocal = [...lis, li('u9', '999', 'Local sin empujar', '1.00')];
  await supabase.from('orders').update({ line_items: conLocal, date_updated: new Date().toISOString() })
    .eq('id', ORDER_ID).eq('site_id', SITE);
  await upsertOrdersFromClover(SITE, [await pedirOrden()], { tableServiceEnabled: true });
  ({ data: o } = await supabase.from('orders').select('line_items').eq('id', ORDER_ID).eq('site_id', SITE).maybeSingle());
  lis = (o as any)?.line_items ?? [];
  const local = lis.find((l) => l.id === 'u9');
  check('MCM-ONLY · la línea local sobrevive al pull', !!local, local ? `status=${local.status}` : 'PERDIDA');
  check('MCM-ONLY · NO se anula por ausencia', local?.status === 'new');

  // ── limpieza ─────────────────────────────────────────────────────────────
  try { await client.post(`/orders/${cloverOrderId}`, { state: 'Deleted' }); } catch { /* best-effort */ }
  await supabase.from('orders').delete().eq('id', ORDER_ID).eq('site_id', SITE);
  console.log('\nlimpieza hecha (orden MCM borrada, orden Clover marcada Deleted)');

  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${ok.length} OK · ${bad.length} FALLAN`);
  if (bad.length) { bad.forEach((b) => console.log('  ' + b)); process.exit(1); }
}

main().catch((e) => { console.error('\nERROR:', e?.message ?? e, e?.responseBody ?? ''); process.exit(1); });
