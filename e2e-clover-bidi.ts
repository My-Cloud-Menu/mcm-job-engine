/**
 * Ciclo BIDIRECCIONAL completo de Clover contra el merchant sandbox REAL.
 *
 * A diferencia de e2e-clover-managed.ts (que nace la orden en MCM y llama al upsert a mano),
 * aquí la orden NACE EN EL TERMINAL y el pull se ejerce por el HANDLER REAL
 * `clover.fetch_open_orders`, con su gate de config, su `fetchStartIso` y su bookkeeping.
 *
 * Seguro para la cola: `complete_sync_schedule` preserva `disabled`
 * (`status = case when status='disabled' then status else 'active' end`), así que correr el
 * handler NO despierta el schedule ni le da trabajo al worker remoto, que corre el dist viejo.
 *
 * Sólo site 99990004. Cero Omnivore.
 */
import './src/handlers/clover/sync/fetch-open-orders';
import './src/handlers/clover/inject/reconcile-items';
import { getHandler } from './src/handlers/registry';
import { upsertOrdersFromClover } from './src/handlers/clover/sync/upsert-orders';
import { cloverIdsOf } from './src/handlers/clover/sync/managed-merge';
import { getSiteIntegrationConfig } from './src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from './src/handlers/clover/client';
import { buildOrdersUrl } from './src/handlers/clover/sync/order-mapper';
import { supabase } from './src/lib/supabase';

const SITE = 99990004;
const SCHED = 'd3ea9793-f165-4864-b89d-4311ee0ca937';
const job: any = { id: 'e2e-bidi', site_id: SITE, correlation_id: 'e2e-bidi' };
const step: any = { idempotency_key: 'e2e-bidi', attempt_count: 0, max_attempts: 3 };

const ok: string[] = []; const bad: string[] = [];
const check = (n: string, c: boolean, d = '') => {
  (c ? ok : bad).push(`${c ? 'OK' : 'FALLA'} ${n}${d ? ' — ' + d : ''}`);
  console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`);
};

async function main() {
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cfg = CloverConfigSchema.parse(config);
  const cl = createCloverClient(cfg, 'e2e-bidi');
  const base = `${cl.defaults.baseURL}`;
  console.log(`merchant=${cfg.merchantId}  tableService=${(cfg as any).cloverTableServiceEnabled}\n`);

  const ventana = async () => ((await cl.get<any>(buildOrdersUrl(base, 0))).data?.elements ?? []) as any[];
  const leer = async (id: string) => (await cl.get<any>(
    `/orders/${id}?expand=lineItems,lineItems.taxRates,lineItems.modifications,payments`)).data;
  const lineas = async (id: string) => ((await leer(id))?.lineItems?.elements ?? []) as any[];
  const mcm = async (id: number) => (await supabase.from('orders')
    .select('line_items, additional_properties, status, total')
    .eq('id', id).eq('site_id', SITE).maybeSingle()).data as any;
  const pull = async () => await (getHandler('clover', 'fetch_open_orders')!)({
    stepInput: { schedule_id: SCHED, cursor: null }, context: {}, job, step } as any) as any;

  // ── Fase 0 · limpieza REAL (state:'Deleted' no borra) ─────────────────────
  console.log('Fase 0 · limpieza y baseline');
  for (const o of await ventana()) { try { await cl.delete(`/orders/${o.id}`); } catch { /* ya no está */ } }
  await supabase.from('orders').delete().eq('site_id', SITE);
  // Una orden CON PAGO resiste el DELETE (400) y no es nuestra: se toma como suelo, no como fallo.
  // Es la razón por la que `deleteCloverTicket` avisa en vez de bloquear el cancel.
  const SUELO = (await ventana()).map((o) => o.id);
  if (SUELO.length) console.log(`   suelo preexistente no borrable: ${SUELO.join(', ')}`);
  const mias = async () => (await ventana()).filter((o) => !SUELO.includes(o.id));
  check('la ventana queda sin órdenes nuestras', (await mias()).length === 0);
  check('el banco MCM queda vacío', ((await supabase.from('orders').select('id').eq('site_id', SITE)).data ?? []).length === 0);

  // ── Fase 1 · NACE EN EL TERMINAL → llega a MCM ────────────────────────────
  console.log('\nFase 1 · la orden nace en Clover y el handler real la trae');
  const nueva = (await cl.post<any>('/orders', { title: 'BIDI mesa 7', state: 'Open', currency: 'USD' })).data;
  const CO = nueva.id;
  await cl.post(`/orders/${CO}/line_items`, { name: 'Cerveza', price: 500 });
  await cl.post(`/orders/${CO}/line_items`, { name: 'Alitas', price: 900 });
  const idsNacimiento = (await lineas(CO)).map((l) => l.id).sort();
  console.log(`   Clover ${CO} con ${idsNacimiento.length} líneas`);

  const p1 = await pull();
  check('el handler real la importa', p1.inserted === 1 + SUELO.length, JSON.stringify(p1));
  const fila = (await supabase.from('orders').select('id').eq('site_id', SITE).eq('clover_ticket_id', CO).maybeSingle()).data as any;
  check('existe en MCM con su clover_ticket_id', !!fila);
  const MO = Number(fila.id);
  let o = await mcm(MO);
  check('NACIDA-EN-CLOVER · queda sellada como gestionada',
        o?.additional_properties?.clover_managed === true,
        `clover_managed=${o?.additional_properties?.clover_managed}`);
  check('NACIDA-EN-CLOVER · con su clover_synced_at', !!o?.additional_properties?.clover_synced_at);
  check('trae las 2 líneas', (o?.line_items ?? []).length === 2, `${(o?.line_items ?? []).length}`);
  check('las 2 vienen ancladas al id de Clover',
        (o.line_items ?? []).filter((l: any) => cloverIdsOf(l).length > 0).length === 2);
  check('marcadas origin=pos',
        (o.line_items ?? []).every((l: any) => l.additional_properties?.clover?.origin === 'pos'));

  // ── Fase 2 · el mesero añade desde /pos-order y se empuja ─────────────────
  console.log('\nFase 2 · MCM → Clover (el mesero añade en /pos-order)');
  const local = { id: 'mcm-local-1', product_id: '777', name: 'Postre MCM', price: '6.00', quantity: 1,
    notes: '', status: 'new', total: '6.00', tax_class: 'standard', attributes: [], additional_properties: {} };
  await supabase.from('orders').update({ line_items: [...(o.line_items ?? []), local],
    date_updated: new Date().toISOString() }).eq('id', MO).eq('site_id', SITE);

  const r: any = await (getHandler('clover', 'reconcile_items')!)({
    jobPayload: { order_id: MO, order_total_cents: 2000, line_items_hash: 'B1',
      line_items: [{ name: 'Cerveza', price: 500 }, { name: 'Alitas', price: 900 }, { name: 'Postre MCM', price: 600 }] },
    context: { create_order: { clover_order_id: CO } }, job, step } as any);
  check('A9 · conserva 2, añade 1, borra 0', r.kept === 2 && r.added === 1 && r.removed === 0, JSON.stringify(r));
  const idsTrasPush = (await lineas(CO)).map((l) => l.id);
  check('A9 · los ids que nacieron en el terminal SOBREVIVEN',
        idsNacimiento.every((i) => idsTrasPush.includes(i)), `${idsNacimiento.filter(i=>idsTrasPush.includes(i)).length}/2`);

  // ── Fase 3 · guard de frescura ────────────────────────────────────────────
  console.log('\nFase 3 · el guard de frescura protege un push recién escrito');
  const snapshotViejo = await leer(CO);
  const antesDelPush = new Date(Date.now() - 60_000).toISOString();
  await supabase.from('orders').update({ additional_properties: {
    ...(await mcm(MO)).additional_properties, clover_synced_at: new Date().toISOString(),
  } }).eq('id', MO).eq('site_id', SITE);
  const marcaLocal = (await mcm(MO)).line_items.length;
  const up = await upsertOrdersFromClover(SITE, [snapshotViejo], { tableServiceEnabled: true, fetchStartIso: antesDelPush });
  check('un pull viejo NO pisa un push más nuevo', up.skipped === 1 && up.updated === 0, JSON.stringify(up));
  check('las líneas de MCM siguen intactas', (await mcm(MO)).line_items.length === marcaLocal);

  // ── Fase 4 · el terminal añade y anula ────────────────────────────────────
  console.log('\nFase 4 · Clover → MCM (el terminal añade y anula)');
  await cl.post(`/orders/${CO}/line_items`, { name: 'Chupito del terminal', price: 400 });
  const alitas = (await lineas(CO)).find((l) => l.name === 'Alitas');
  await cl.delete(`/orders/${CO}/line_items/${alitas.id}`);
  const sinEmpujar = { ...local, id: 'mcm-local-2', name: 'Café sin firear' };
  await supabase.from('orders').update({ line_items: [...(await mcm(MO)).line_items, sinEmpujar],
    date_updated: new Date().toISOString() }).eq('id', MO).eq('site_id', SITE);

  const p2 = await pull();
  check('el handler real actualiza (no inserta otra)', p2.updated >= 1 && p2.inserted === 0, JSON.stringify(p2));
  o = await mcm(MO);
  const chupito = (o.line_items ?? []).find((l: any) => l.name === 'Chupito del terminal');
  check('POS-ADD · lo tecleado en el terminal llega a MCM', !!chupito);
  check('POS-ADD · marcado origin=pos', chupito?.additional_properties?.clover?.origin === 'pos');
  const anulada = (o.line_items ?? []).find((l: any) => l.name === 'Alitas');
  check('TERMINAL-VOID · lo anulado en el terminal se marca voided', anulada?.status === 'voided', `status=${anulada?.status}`);
  check('TERMINAL-VOID · con su motivo', anulada?.void_reason === 'voided at terminal');
  const cafe = (o.line_items ?? []).find((l: any) => l.id === 'mcm-local-2');
  check('MCM-UNFIRED · la línea sin firear SOBREVIVE al pull', !!cafe, cafe ? `status=${cafe.status}` : 'PERDIDA');
  check('MCM-UNFIRED · NO se anula por ausencia', cafe?.status === 'new');
  // Cerveza + Alitas(voided, se CONSERVA) + Postre MCM + Chupito + Café sin firear = 5.
  check('sin duplicar: 5 líneas exactas', (o.line_items ?? []).length === 5, `${(o.line_items ?? []).length}`);

  // ── Fase 5 · una orden marcada Deleted NO resucita ────────────────────────
  console.log('\nFase 5 · una orden marcada Deleted no vuelve como ticket vivo');
  const zombi = (await cl.post<any>('/orders', { title: 'BIDI zombi', state: 'Open', currency: 'USD' })).data;
  await cl.post(`/orders/${zombi.id}/line_items`, { name: 'Fantasma', price: 100 });
  await cl.post(`/orders/${zombi.id}`, { state: 'Deleted' });
  const sigue = (await ventana()).some((x) => x.id === zombi.id);
  check('Clover SIGUE devolviéndola en el pull (la trampa)', sigue);
  const p3 = await pull();
  const resucitada = (await supabase.from('orders').select('id').eq('site_id', SITE).eq('clover_ticket_id', zombi.id).maybeSingle()).data;
  check('el upsert NO la importa como ticket vivo', !resucitada, resucitada ? 'RESUCITÓ' : 'filtrada');
  check('y la cuenta como saltada', p3.skipped >= 1, JSON.stringify(p3));

  // ── Fase 6 · limpieza real + invariantes ──────────────────────────────────
  console.log('\nFase 6 · limpieza');
  for (const x of await ventana()) { try { await cl.delete(`/orders/${x.id}`); } catch { /* */ } }
  await supabase.from('orders').delete().eq('site_id', SITE);
  check('merchant limpio de lo nuestro', (await mias()).length === 0);
  check('banco limpio', ((await supabase.from('orders').select('id').eq('site_id', SITE)).data ?? []).length === 0);
  const { data: s } = await supabase.from('sync_schedules').select('status').eq('id', SCHED).single();
  check('el schedule sigue disabled (la cola no se despertó)', (s as any)?.status === 'disabled', `status=${(s as any)?.status}`);

  console.log(`\n${'='.repeat(58)}\nRESULTADO: ${ok.length} OK · ${bad.length} FALLAN`);
  if (bad.length) { bad.forEach((b) => console.log('  ' + b)); process.exit(1); }
}
main().catch((e) => { console.error('\nERROR:', e?.message ?? e, e?.responseBody ?? ''); process.exit(1); });
