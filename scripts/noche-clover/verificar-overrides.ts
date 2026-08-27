/** Verificación en vivo de los overrides cosméticos, contra el merchant real. */
import { supabase } from '../../src/lib/supabase';
import { getSiteIntegrationConfig, invalidateCredentialsCache } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';
import '../../src/handlers/clover/sync/fetch-products';
import { getHandler } from '../../src/handlers/registry';

const SITE = 99990004;
const ok: string[] = []; const mal: string[] = [];
const chk = (n: string, c: boolean, d = '') => { (c ? ok : mal).push(n); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };
const sync = () => getHandler('clover', 'fetch_products')!({
  stepInput: { schedule_id: null, manual: true }, jobPayload: { manual: true }, context: {},
  job: { id: 'o', site_id: SITE, correlation_id: 'o' } as any,
  step: { idempotency_key: 'o', attempt_count: 0, max_attempts: 1 } as any } as any) as Promise<any>;
const prod = async (cid: string) => (await supabase.from('products').select('*')
  .eq('site_id', SITE).contains('additional_properties', { cloverId: cid }).maybeSingle()).data as any;

/** La config se cachea 60 s (`credentials.ts:15`): cambiarla en la DB NO basta. */
const setBandera = async (filaId: string, cfg: any, valor: boolean | undefined) => {
  const nueva = { ...cfg };
  if (valor === undefined) delete nueva.cloverPreserveLocalEdits; else nueva.cloverPreserveLocalEdits = valor;
  await supabase.from('site_integrations').update({ config: nueva }).eq('id', filaId).eq('site_id', SITE);
  invalidateCredentialsCache(SITE, 'clover');
};

(async () => {
  const { data: fila } = await supabase.from('site_integrations').select('id, config')
    .eq('site_id', SITE).eq('provider', 'clover').eq('type', 'pos').single();
  const FID = (fila as any).id; const cfgOrig = (fila as any).config;
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cl = createCloverClient(CloverConfigSchema.parse(config), 'o', SITE);
  const it = (await cl.post<any>('/items', { name: 'OVR Original', price: 500 })).data;
  try {
    await sync();
    let p = await prod(it.id);
    console.log(`producto ${it.id}: "${p.name}"`);
    await supabase.from('products').update({ name: 'OVR Mi Nombre' }).eq('id', p.id).eq('site_id', SITE);
    await sync();
    p = await prod(it.id);
    chk('bandera APAGADA: Clover pisa la edición (conducta de siempre)', p.name === 'OVR Original', `"${p.name}"`);

    await setBandera(FID, cfgOrig, true);
    await sync();                                     // registra la línea base
    await supabase.from('products').update({ name: 'OVR Mi Nombre', description: 'Mi descripción' })
      .eq('id', p.id).eq('site_id', SITE);
    await sync();
    p = await prod(it.id);
    chk('bandera ENCENDIDA: la edición de MCM sobrevive', p.name === 'OVR Mi Nombre', `"${p.name}"`);
    chk('la descripción también', p.description === 'Mi descripción', `"${p.description}"`);
    chk('queda anotado en cloverOverrides',
        JSON.stringify(p.additional_properties?.cloverOverrides ?? []).includes('name'),
        JSON.stringify(p.additional_properties?.cloverOverrides));

    await cl.post(`/items/${it.id}`, { name: 'OVR Cambiado en Clover', price: 750 });
    await sync();
    p = await prod(it.id);
    chk('Clover cambia el nombre: NO gana', p.name === 'OVR Mi Nombre', `"${p.name}"`);
    chk('pero el PRECIO sí (el dinero nunca se protege)', Number(p.price) === 7.5, `$${p.price}`);

    await cl.post(`/items/${it.id}`, { available: false });
    await sync();
    p = await prod(it.id);
    chk('el 86 sigue llegando (stock_status nunca se protege)', p.stock_status === 'outofstock', p.stock_status);

    const a: any = await sync(); const b: any = await sync();
    chk('sigue siendo idempotente con overrides activos',
        b.products.updated === 0 && b.products.created === 0, `1a upd=${a.products.updated} · 2a upd=${b.products.updated}`);

    await supabase.from('products').update({ name: 'OVR Cambiado en Clover' }).eq('id', p.id).eq('site_id', SITE);
    await sync();
    p = await prod(it.id);
    chk('volver al valor de Clover LIBERA el override', !(p.additional_properties?.cloverOverrides ?? []).includes('name'),
        `overrides=${JSON.stringify(p.additional_properties?.cloverOverrides)}`);

    await supabase.from('products').update({ name: 'OVR Otra Vez Mío',
      additional_properties: { ...p.additional_properties, cloverAdoptOnNextSync: true } })
      .eq('id', p.id).eq('site_id', SITE);
    await sync();
    p = await prod(it.id);
    chk('`cloverAdoptOnNextSync` fuerza volver a lo de Clover', p.name === 'OVR Cambiado en Clover', `"${p.name}"`);
    chk('y la marca se auto-borra', !p.additional_properties?.cloverAdoptOnNextSync);
  } finally {
    await cl.delete(`/items/${it.id}`).catch(() => {});
    await setBandera(FID, cfgOrig, undefined);
    await sync().catch(() => {});
    await supabase.from('products').delete().eq('site_id', SITE).like('name', 'OVR%');
    const { data: c } = await supabase.from('site_integrations').select('config').eq('id', FID).single();
    console.log(`\n  bandera restaurada: cloverPreserveLocalEdits=${(c as any).config.cloverPreserveLocalEdits ?? '(ausente)'}`);
  }
  console.log(`\nRESULTADO: ${ok.length} OK · ${mal.length} FALLAN`);
  if (mal.length) process.exit(1);
})().catch((e) => { console.error('ERR', e?.message); process.exit(1); });
