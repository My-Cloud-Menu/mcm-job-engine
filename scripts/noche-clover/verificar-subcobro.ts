/**
 * EN VIVO · el sub-cobro del modo gestionado, reproducido de punta a punta.
 *
 * Escenario (el silencioso, sin diálogo): el mesero tiene un ítem RETENIDO en MCM —que nunca se
 * firea— y alguien teclea otro en el terminal Clover. Antes, el pull descartaba los totales del POS
 * y ese ítem del terminal quedaba LISTADO EN LA CUENTA SIN SUMAR AL TOTAL.
 *
 * Comprueba además la regresión a evitar: una mesa recién abierta (ticket Clover vacío) NO puede
 * quedarse con «Cobrar $0.00».
 *
 * Sólo toca el banco 99990004. Limpia lo que crea.
 */
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';
import { upsertOrdersFromClover } from '../../src/handlers/clover/sync/upsert-orders';
import { supabase } from '../../src/lib/supabase';

const SITE = 99990004;
const EXPAND = 'expand=lineItems,lineItems.taxRates,lineItems.modifications,payments';
const ok: string[] = [], mal: string[] = [];
const check = (n: string, c: boolean, d = '') => {
  (c ? ok : mal).push(n); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`);
};
const li = (id: string, name: string, price: string, extra: any = {}) => ({
  id, product_id: '', name, price, quantity: 1, notes: '', status: 'new',
  total: price, total_tax: '0', tax_class: 'standard', attributes: [],
  additional_properties: {}, ...extra,
});

(async () => {
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const c = createCloverClient(CloverConfigSchema.parse(config), 'ver-subcobro', SITE);

  // 1) mesa abierta: orden MCM + orden Clover VACÍA (como openCloverTicketForManagedOrder)
  const { data: ordClover } = await c.post<any>('/orders', { state: 'open', title: 'VER subcobro' });
  const { data: nueva } = await supabase.from('orders').insert({
    site_id: SITE, channel: 'pos', status: 'new-order', payment_status: 'not_fulfilled',
    currency: 'USD', line_items: [li('u1', 'Cafe', '5.00'), li('u2', 'Postre', '4.00', { held: true })],
    subtotal: 9, total: 9, total_tax: 0, paid: 0, discount_total: 0, shipping_total: 0, fee_total: 0,
    clover_ticket_id: ordClover.id,
    additional_properties: { clover_managed: true },
    date_created: new Date().toISOString(), date_updated: new Date().toISOString(),
  }).select('id').single();
  const orderId = Number((nueva as any).id);
  console.log(`\norden MCM ${orderId} · ticket Clover ${ordClover.id}`);
  console.log(`  MCM tiene: Cafe 5.00 + Postre 4.00 (RETENIDO) = 9.00\n`);

  const leerClover = async () => (await c.get<any>(`/orders/${ordClover.id}?${EXPAND}`)).data;
  const leerMcm = async () => (await supabase.from('orders').select('total, subtotal, line_items')
    .eq('id', orderId).eq('site_id', SITE).maybeSingle()).data as any;

  // 2) REGRESIÓN: ticket vacío → el total de MCM no se pisa con cero
  await upsertOrdersFromClover(SITE, [await leerClover()], { tableServiceEnabled: true });
  const t0 = await leerMcm();
  check('ticket Clover VACÍO: no pisa el total con $0.00', Number(t0.total) === 9, `total=${t0.total}`);

  // 3) el mesero firea SÓLO el café → llega a Clover con su ancla
  const { data: lCafe } = await c.post<any>(`/orders/${ordClover.id}/line_items`, { name: 'Cafe', price: 500 });
  await supabase.from('orders').update({
    line_items: [
      li('u1', 'Cafe', '5.00', { status: 'sent',
        additional_properties: { clover: { line_item_ids: [lCafe.id], origin: 'mcm' } } }),
      li('u2', 'Postre', '4.00', { held: true }),
    ],
    date_updated: new Date().toISOString(),
  }).eq('id', orderId).eq('site_id', SITE);

  // 4) EL COMPAÑERO TECLEA UNA CERVEZA EN EL TERMINAL
  await c.post(`/orders/${ordClover.id}/line_items`, { name: 'Cerveza', price: 600 });
  console.log('  el terminal añade: Cerveza 6.00  →  la cuenta real son 15.00\n');

  // 5) corre el pull
  await upsertOrdersFromClover(SITE, [await leerClover()], { tableServiceEnabled: true });
  const t1 = await leerMcm();
  const nombres = (t1.line_items ?? []).map((l: any) => l.name);

  check('la cerveza del terminal aparece en la cuenta', nombres.includes('Cerveza'), nombres.join(', '));
  check('EL TOTAL LA INCLUYE (antes: 9.00, se cobraba de menos)', Number(t1.total) === 15,
        `total=${t1.total} · esperado 15.00`);
  check('el postre retenido sigue intacto', (t1.line_items ?? []).some((l: any) => l.id === 'u2' && l.held));
  check('el total no es NaN ni null', t1.total != null && !Number.isNaN(Number(t1.total)));

  // limpieza
  await supabase.from('orders').delete().eq('id', orderId).eq('site_id', SITE);
  try { await c.delete(`/orders/${ordClover.id}`); } catch { await c.post(`/orders/${ordClover.id}`, { state: 'Deleted' }); }
  console.log('\n  limpieza hecha');
  console.log(`\nRESULTADO: ${ok.length} OK · ${mal.length} FALLAN`);
  process.exit(mal.length ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e?.message, JSON.stringify(e?.response?.data ?? '')); process.exit(1); });
