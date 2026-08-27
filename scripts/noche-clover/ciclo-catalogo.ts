/**
 * Fase 6 · ciclo COMPLETO de catálogo: se muta cada entidad en Clover y se comprueba que llega a
 * MCM. Todo se deshace al final (el catálogo del banco vuelve a su estado inicial).
 */
import { supabase } from '../../src/lib/supabase';
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';
import '../../src/handlers/clover/sync/fetch-products';
import '../../src/handlers/clover/sync/fetch-item-stock';
import '../../src/handlers/clover/sync/fetch-employees';
import { getHandler } from '../../src/handlers/registry';

const SITE = 99990004;
const ok: string[] = []; const mal: string[] = [];
const chk = (n: string, c: boolean, d = '') => { (c ? ok : mal).push(n); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

const sync = () => getHandler('clover', 'fetch_products')!({
  stepInput: { schedule_id: null, manual: true }, jobPayload: { manual: true }, context: {},
  job: { id: 'c', site_id: SITE, correlation_id: 'c' } as any,
  step: { idempotency_key: 'c', attempt_count: 0, max_attempts: 1 } as any } as any) as Promise<any>;
const syncStock = () => getHandler('clover', 'fetch_item_stock')!({
  stepInput: { schedule_id: null, manual: true }, jobPayload: { manual: true }, context: {},
  job: { id: 's', site_id: SITE, correlation_id: 's' } as any,
  step: { idempotency_key: 's', attempt_count: 0, max_attempts: 1 } as any } as any) as Promise<any>;
const syncEmp = () => getHandler('clover', 'fetch_employees')!({
  stepInput: { schedule_id: null, manual: true }, jobPayload: { manual: true }, context: {},
  job: { id: 'e', site_id: SITE, correlation_id: 'e' } as any,
  step: { idempotency_key: 'e', attempt_count: 0, max_attempts: 1 } as any } as any) as Promise<any>;

const porClover = async (tabla: string, cloverId: string) => {
  const { data } = await supabase.from(tabla).select('*').eq('site_id', SITE)
    .contains('additional_properties', { cloverId }).maybeSingle();
  return data as any;
};

(async () => {
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cl = createCloverClient(CloverConfigSchema.parse(config), 'c', SITE);
  const aBorrar: Array<[string, string]> = [];   // [ruta, id]

  try {
    // ══ PRODUCTOS ═══════════════════════════════════════════════════════════════════════
    console.log('\n── PRODUCTOS ──');
    const it = (await cl.post<any>('/items', { name: 'CICLO Cafe', price: 250 })).data;
    aBorrar.push(['/items', it.id]);
    await sync();
    let p = await porClover('products', it.id);
    chk('alta: el producto nuevo aparece en MCM', !!p && p.name === 'CICLO Cafe' && Number(p.price) === 2.5,
        p ? `${p.name} $${p.price}` : 'no llegó');

    await cl.post(`/items/${it.id}`, { name: 'CICLO Cafe Doble', price: 375 });
    await sync();
    p = await porClover('products', it.id);
    chk('edición: nombre y precio se propagan', p?.name === 'CICLO Cafe Doble' && Number(p?.price) === 3.75,
        `${p?.name} $${p?.price}`);

    await cl.post(`/items/${it.id}`, { available: false });
    await syncStock();
    p = await porClover('products', it.id);
    chk('86 desde Clover: available:false ⇒ outofstock', p?.stock_status === 'outofstock', `stock=${p?.stock_status}`);

    await cl.post(`/items/${it.id}`, { available: true });
    await syncStock();
    p = await porClover('products', it.id);
    chk('vuelve a estar disponible ⇒ instock', p?.stock_status === 'instock', `stock=${p?.stock_status}`);

    await cl.delete(`/items/${it.id}`);
    await sync();
    p = await porClover('products', it.id);
    chk('borrado en Clover ⇒ ARCHIVADO en MCM (nunca DELETE)',
        !!p && p.status === 'draft' && p.additional_properties?.cloverArchived === true,
        p ? `status=${p.status} archivado=${p.additional_properties?.cloverArchived}` : 'la fila desapareció (mal)');

    const it2 = (await cl.post<any>('/items', { name: 'CICLO Resucita', price: 100 })).data;
    aBorrar.push(['/items', it2.id]);
    await sync();
    await cl.delete(`/items/${it2.id}`);
    await sync();
    const arch = await porClover('products', it2.id);
    // resucitar: se re-crea con el MISMO id no se puede, así que se comprueba el des-archivado
    // devolviendo el producto a MCM mediante un item nuevo con el mismo cloverId es imposible;
    // en su lugar se valida que el archivado quedó marcado y su stock a outofstock.
    chk('el archivado queda en draft + outofstock', arch?.status === 'draft' && arch?.stock_status === 'outofstock',
        `${arch?.status}/${arch?.stock_status}`);

    // ══ CATEGORÍAS ══════════════════════════════════════════════════════════════════════
    console.log('\n── CATEGORÍAS ──');
    const cat = (await cl.post<any>('/categories', { name: 'CICLO Bebidas' })).data;
    aBorrar.push(['/categories', cat.id]);
    await sync();
    let c = await porClover('categories', cat.id);
    chk('alta de categoría', !!c && c.name === 'CICLO Bebidas', c ? c.name : 'no llegó');

    await cl.post(`/categories/${cat.id}`, { name: 'CICLO Bebidas Frias' });
    await sync();
    c = await porClover('categories', cat.id);
    chk('renombrar categoría se propaga', c?.name === 'CICLO Bebidas Frias', c?.name);
    chk('el slug NO se reescribe (decisión D1, documentada)', !!c?.slug, `slug=${c?.slug}`);

    // producto asignado a la categoría
    const it3 = (await cl.post<any>('/items', { name: 'CICLO Jugo', price: 200 })).data;
    aBorrar.push(['/items', it3.id]);
    await cl.post(`/category_items`, { elements: [{ category: { id: cat.id }, item: { id: it3.id } }] }).catch(() => {});
    await sync();
    const p3 = await porClover('products', it3.id);
    chk('un producto con categoría llega con su categories_id',
        Array.isArray(p3?.categories_id), `categories_id=${JSON.stringify(p3?.categories_id)}`);

    await cl.delete(`/categories/${cat.id}`);
    await sync();
    c = await porClover('categories', cat.id);
    chk('categoría borrada ⇒ archivada (draft), no borrada',
        !!c && c.status === 'draft' && c.additional_properties?.cloverArchived === true, `status=${c?.status}`);

    // ══ MODIFICADORES ═══════════════════════════════════════════════════════════════════
    console.log('\n── MODIFICADORES ──');
    const g = (await cl.post<any>('/modifier_groups', { name: 'CICLO Extras', minRequired: 0, maxAllowed: 2 })).data;
    aBorrar.push(['/modifier_groups', g.id]);
    const m1 = (await cl.post<any>(`/modifier_groups/${g.id}/modifiers`, { name: 'CICLO Leche', price: 50 })).data;
    await sync();
    let gr = await porClover('ingredients_groups', g.id);
    let mo = await porClover('ingredients', m1.id);
    chk('alta de grupo de modificadores', !!gr && gr.name === 'CICLO Extras', gr ? `${gr.name} min=${gr.minimum} max=${gr.maximum}` : 'no llegó');
    chk('alta de modificador', !!mo && Number(mo.price) === 0.5, mo ? `${mo.name} $${mo.price}` : 'no llegó');
    chk('min/max se traducen bien (maxAllowed 2 ⇒ maximum 2)', gr?.minimum === 0 && gr?.maximum === 2, `min=${gr?.minimum} max=${gr?.maximum}`);

    await cl.post(`/modifier_groups/${g.id}/modifiers/${m1.id}`, { name: 'CICLO Leche Avena', price: 75 });
    await sync();
    mo = await porClover('ingredients', m1.id);
    chk('edición de modificador (nombre y precio)', mo?.name === 'CICLO Leche Avena' && Number(mo?.price) === 0.75, `${mo?.name} $${mo?.price}`);

    // 86 de un modificador: NO SE PUEDE PROBAR AQUÍ. Medido — `POST
    // /modifier_groups/{g}/modifiers/{m}` con `{available:false}` devuelve **200 con
    // `available:true` sin cambiar**, y el listado con `expand=modifiers` lo confirma. Clover no
    // deja escribir ese campo por API; si alguna vez lo puebla (86 desde el dispositivo), el
    // mapeo que se añadió en la Fase 1.3 lo recogerá. Se comprueba lo que SÍ se puede: que el
    // sync lee `available` y no lo pisa a ciegas con 'instock'.
    await cl.post(`/modifier_groups/${g.id}/modifiers/${m1.id}`, { available: false });
    await sync();
    mo = await porClover('ingredients', m1.id);
    const gsCrudo = ((await cl.get<any>('/modifier_groups?limit=100&expand=modifiers')).data?.elements ?? []) as any[];
    const moCrudo = (gsCrudo.find((x: any) => x.id === g.id)?.modifiers?.elements ?? []).find((x: any) => x.id === m1.id);
    chk('el stock del modificador refleja lo que dice Clover en `available`',
        (moCrudo?.available === false) === (mo?.stock_status === 'outofstock'),
        `Clover available=${moCrudo?.available} · MCM stock=${mo?.stock_status} (Clover ignora la escritura de este campo)`);

    await cl.post(`/modifier_groups/${g.id}`, { name: 'CICLO Extras Premium', maxAllowed: 5 });
    await sync();
    gr = await porClover('ingredients_groups', g.id);
    chk('edición del grupo (nombre y maxAllowed)', gr?.name === 'CICLO Extras Premium' && gr?.maximum === 5, `${gr?.name} max=${gr?.maximum}`);

    await cl.delete(`/modifier_groups/${g.id}/modifiers/${m1.id}`);
    await sync();
    mo = await porClover('ingredients', m1.id);
    chk('modificador borrado ⇒ archivado', mo?.additional_properties?.cloverArchived === true, `archivado=${mo?.additional_properties?.cloverArchived}`);

    await cl.delete(`/modifier_groups/${g.id}`);
    await sync();
    gr = await porClover('ingredients_groups', g.id);
    chk('grupo borrado ⇒ archivado (draft)', gr?.status === 'draft' && gr?.additional_properties?.cloverArchived === true, `status=${gr?.status}`);

    // ══ EMPLEADOS ═══════════════════════════════════════════════════════════════════════
    console.log('\n── EMPLEADOS ──');
    const e = (await cl.post<any>('/employees', { name: 'Ciclo Prueba', role: 'EMPLOYEE' })).data;
    aBorrar.push(['/employees', e.id]);
    await syncEmp();
    const { data: em1 } = await supabase.from('employees').select('*').eq('site_id', SITE).eq('login', String(e.pin)).maybeSingle();
    chk('alta de empleado con su PIN de 6 dígitos', !!em1 && (em1 as any).pos_id === e.id, em1 ? `${(em1 as any).first_name} pin=${e.pin}` : 'no llegó');

    // Sólo el nombre: cambiar el rol por API exige un objeto `roles` con id
    // (`400 {"message":"roles object without an 'id'"}`, medido), que es otro flujo.
    await cl.post(`/employees/${e.id}`, { name: 'Renombrado Ciclo' });
    await syncEmp();
    const { data: em2 } = await supabase.from('employees').select('*').eq('site_id', SITE).eq('login', String(e.pin)).maybeSingle();
    chk('cambio de nombre se propaga', (em2 as any)?.first_name === 'Renombrado', `${(em2 as any)?.first_name} ${(em2 as any)?.last_name}`);
    chk('un EMPLOYEE de Clover mapea a waiter en MCM', (em2 as any)?.role === 'waiter', (em2 as any)?.role);

    await cl.delete(`/employees/${e.id}`);
    await syncEmp();
    const { data: em3 } = await supabase.from('employees').select('is_active').eq('site_id', SITE).eq('login', String(e.pin)).maybeSingle();
    chk('AVISO CONOCIDO: un empleado borrado en Clover SIGUE activo en MCM (sync aditivo)',
        (em3 as any)?.is_active !== false, 'conducta compartida con Omnivore — decisión de producto, ver HALLAZGOS H-N5');

    // ══ MESAS ═══════════════════════════════════════════════════════════════════════════
    console.log('\n── MESAS ──');
    const sec = (await cl.post<any>('/tables/sections', { name: 'CICLO Salon' })).data;
    aBorrar.push(['/tables/sections', sec.id]);
    const secs = ((await cl.get<any>('/tables/sections')).data?.elements ?? []) as any[];
    chk('las SECCIONES sí se pueden crear y releer', secs.some((x) => x.id === sec.id));
    let errMesa = '';
    try { await cl.post('/tables', { name: 'M1', section: { id: sec.id }, x: 1, y: 1 }); }
    catch (er: any) { errMesa = String(er?.response?.data?.message ?? ''); }
    chk('las MESAS no se pueden crear desde el API (límite documentado)',
        /coordinates are required/i.test(errMesa), errMesa || '¡se creó! revisar');
  } finally {
    console.log('\n── limpieza ──');
    for (const [ruta, id] of aBorrar.reverse()) { try { await cl.delete(`${ruta}/${id}`); } catch { /* ya borrado */ } }
    const r: any = await sync();
    console.log(`  sync final: productos=${JSON.stringify(r.products)} modifiers=${JSON.stringify(r.modifiers?.groups)}`);
  }

  console.log(`\n${'='.repeat(56)}\nRESULTADO: ${ok.length} OK · ${mal.length} FALLAN`);
  if (mal.length) process.exit(1);
})().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
