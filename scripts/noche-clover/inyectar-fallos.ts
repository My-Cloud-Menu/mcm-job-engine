/**
 * Fase 5 · fallos y casos raros, de punta a punta contra Clover REAL con un proxy que sabotea el
 * transporte (`proxy-fallos.ts`). El estado en Clover es real; sólo se rompe la red.
 */
import { supabase } from '../../src/lib/supabase';
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';
import '../../src/handlers/clover/inject/create-order';
import '../../src/handlers/clover/inject/reconcile-items';
import { getHandler } from '../../src/handlers/registry';

const SITE = 99990004;
const PROXY = 'http://127.0.0.1:8899';
const ok: string[] = []; const mal: string[] = [];
const chk = (n: string, c: boolean, d = '') => { (c ? ok : mal).push(n); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };
const sabotear = (patron: string, modo: string, veces: number) =>
  fetch(`${PROXY}/__fallo`, { method: 'POST', body: JSON.stringify({ patron, modo, veces }) });
const reset = () => fetch(`${PROXY}/__reset`, { method: 'POST' });

(async () => {
  const { data: fila } = await supabase.from('site_integrations').select('id, config')
    .eq('site_id', SITE).eq('provider', 'clover').eq('type', 'pos').single();
  const cfgOriginal = (fila as any).config;
  const cfgReal = CloverConfigSchema.parse(cfgOriginal);
  // Cliente DIRECTO a Clover, para comprobar la verdad sin pasar por el saboteador.
  const directo = createCloverClient(cfgReal, 'v', SITE);

  // Los handlers construyen su propio cliente desde `site_integrations`, así que la única forma
  // de meterles el proxy es apuntar la config del site a él. Se restaura en el `finally`, pase lo
  // que pase — y se vuelve a comprobar al final.
  const apuntarAlProxy = () => supabase.from('site_integrations')
    .update({ config: { ...cfgOriginal, apiUrl: PROXY } }).eq('id', (fila as any).id).eq('site_id', SITE);
  const restaurar = () => supabase.from('site_integrations')
    .update({ config: cfgOriginal }).eq('id', (fila as any).id).eq('site_id', SITE);
  await apuntarAlProxy();
  console.log(`config del site apuntando al proxy (${PROXY}); se restaurará al terminar`);
  const job: any = { id: 'f', site_id: SITE, correlation_id: 'f' };
  const paso = (attempt = 0) => ({ idempotency_key: 'f', attempt_count: attempt, max_attempts: 5 } as any);

  const nuevaOrdenMcm = async (lineas: Array<{ n: string; c: number }>) => {
    const base = lineas.reduce((s, l) => s + l.c, 0);
    const tax = Math.round(base * 0.115);
    const { data } = await supabase.from('orders').insert({
      site_id: SITE, channel: 'online', status: 'in-kitchen', payment_status: 'not_fulfilled', currency: 'USD',
      line_items: lineas.map((l, k) => ({ id: `f${k}`, product_id: '', name: l.n, price: (l.c/100).toFixed(2),
        quantity: 1, notes: '', status: 'sent', total: (l.c/100).toFixed(2),
        total_tax: (Math.round(l.c*0.115)/100).toFixed(2), tax_class: 'standard', attributes: [], additional_properties: {} })),
      subtotal: base/100, total: (base+tax)/100, total_tax: tax/100, paid: 0,
      discount_total: 0, shipping_total: 0, fee_total: 0, additional_properties: {},
      date_created: new Date().toISOString(), date_updated: new Date().toISOString(),
    }).select('id').single();
    return Number((data as any).id);
  };
  const crearTicket = async (oid: number) => {
    const ref = 'f' + Math.random().toString(36).slice(2, 9);
    const r: any = await getHandler('clover', 'create_order')!({
      jobPayload: { order_id: oid, external_reference_id: ref,
        order_body: { title: 'FALLO', state: 'Open', currency: 'USD', externalReferenceId: ref } },
      context: {}, job, step: paso() } as any);
    return r.clover_order_id as string;
  };
  const lineasDe = async (tid: string) =>
    ((await directo.get<any>(`/orders/${tid}?expand=lineItems`)).data?.lineItems?.elements ?? []) as any[];
  const reconciliar = (oid: number, tid: string, lineas: any[], hash: string, totalCent: number, attempt = 0) =>
    getHandler('clover', 'reconcile_items')!({
      jobPayload: { order_id: oid, order_total_cents: totalCent, line_items_hash: hash, line_items: lineas },
      context: { create_order: { clover_order_id: tid } }, job, step: paso(attempt) } as any);

  const basura: string[] = []; const basuraMcm: number[] = [];
  const limpiar = async () => {
    for (const t of basura) { try { await directo.delete(`/orders/${t}`); } catch { /* pagada */ } }
    for (const o of basuraMcm) await supabase.from('orders').delete().eq('id', o).eq('site_id', SITE);
  };

  try {
    // ── F1 · 429 transitorio: el cliente lo absorbe, la operación termina bien ─────────────
    console.log('\nF1 · 429 transitorio en pleno empujón');
    await reset();
    {
      const oid = await nuevaOrdenMcm([{ n: 'A', c: 500 }, { n: 'B', c: 300 }]); basuraMcm.push(oid);
      const tid = await crearTicket(oid); basura.push(tid);
      await sabotear('line_items', '429', 2);
      const t0 = Date.now();
      const r: any = await reconciliar(oid, tid, [{ name: 'A', price: 500 }, { name: 'B', price: 300 }], 'F1', 892);
      const ls = await lineasDe(tid);
      chk('el 429 se absorbe y la orden se empuja igual', r.added === 2 && ls.length === 2, `${ls.length} líneas en ${Date.now()-t0}ms`);
      const st = await (await fetch(`${PROXY}/__stats`)).json() as any;
      chk('el proxy saboteó de verdad', st.saboteadas >= 2, `${st.saboteadas} saboteadas`);
    }

    // ── F2 · 5xx permanente: el job falla con un texto que el auto-retry SÍ reconoce ───────
    console.log('\nF2 · 5xx permanente (¿lo recoge el auto-retry de dead-letters?)');
    await reset();
    {
      const oid = await nuevaOrdenMcm([{ n: 'C', c: 400 }]); basuraMcm.push(oid);
      const tid = await crearTicket(oid); basura.push(tid);
      await sabotear('line_items', '500', 99);
      let msg = '';
      try { await reconciliar(oid, tid, [{ name: 'C', price: 400 }], 'F2', 446); }
      catch (e: any) { msg = String(e?.message ?? ''); }
      chk('el 5xx sube como error', msg.length > 0, msg.slice(0, 70));
      // el filtro del auto-retry (migración 024 + el parche de Clover de anoche)
      const casaFiltro = /HTTP 50|HTTP 429/i.test(msg)
        || /Clover (429|5[0-9]{2})[: ]/.test(msg) || /edge returned 5[0-9]{2}/.test(msg)
        || /socket disconnected|Service Temporarily Unavailable|Too Many Requests|ECONNRESET|EAI_AGAIN/i.test(msg);
      chk('el texto lo reconoce el auto-retry de dead-letters (H1)', casaFiltro, msg.slice(0, 70));
    }

    // ── F3 · corte de socket a mitad: NO se duplica (el delta se autocura) ────────────────
    console.log('\nF3 · corte de conexión a mitad del empujón, y reintento');
    await reset();
    {
      const oid = await nuevaOrdenMcm([{ n: 'D', c: 200 }, { n: 'E', c: 200 }, { n: 'F', c: 200 }]); basuraMcm.push(oid);
      const tid = await crearTicket(oid); basura.push(tid);
      const deseadas = [{ name: 'D', price: 200 }, { name: 'E', price: 200 }, { name: 'F', price: 200 }];
      await sabotear('line_items', 'cortar', 1);
      try { await reconciliar(oid, tid, deseadas, 'F3', 669); } catch { /* esperado */ }
      const tras1 = (await lineasDe(tid)).length;
      await reset();
      const r2: any = await reconciliar(oid, tid, deseadas, 'F3', 669, 1);   // reintento
      const ls = await lineasDe(tid);
      chk('tras el corte y el reintento hay EXACTAMENTE 3 líneas, sin duplicar',
          ls.length === 3, `tras el corte: ${tras1} · tras reintentar: ${ls.length} · ${JSON.stringify(r2)}`);
    }

    // ── F4 · ticket BORRADO en Clover mientras MCM edita ──────────────────────────────────
    console.log('\nF4 · el ticket desaparece de Clover mientras MCM lo edita');
    await reset();
    {
      const oid = await nuevaOrdenMcm([{ n: 'G', c: 900 }]); basuraMcm.push(oid);
      const tid = await crearTicket(oid);
      await reconciliar(oid, tid, [{ name: 'G', price: 900 }], 'F4a', 1004);
      await directo.delete(`/orders/${tid}`);                 // el terminal lo borra
      let err = '';
      try { await reconciliar(oid, tid, [{ name: 'G', price: 900 }, { name: 'H', price: 100 }], 'F4b', 1115); }
      catch (e: any) { err = String(e?.message ?? ''); }
      chk('falla de forma explícita, no en silencio', err.length > 0, err.slice(0, 70));
    }

    // ── F5 · credenciales inválidas: 401 NO reintentable ─────────────────────────────────
    console.log('\nF5 · POS "caído" (credenciales inválidas)');
    await reset();
    {
      const malo = createCloverClient({ ...cfgReal, apiKey: 'token-invalido' } as any, 'v', SITE);
      let st = 0; let msg = '';
      try { await malo.get('/orders?limit=1'); }
      catch (e: any) { st = e?.response?.status ?? 0; msg = String(e?.message); }
      chk('un token inválido da 401', st === 401, `status=${st}`);
      const { mapCloverError } = await import('../../src/handlers/clover/error-map');
      const he: any = mapCloverError({ isAxiosError: true, response: { status: 401, data: {} }, message: 'x' }, 'X');
      chk('el 401 NO es reintentable (la clave no se arregla sola)', he.retryable === false);
    }

    // ── F6 · idempotencia del encolado ───────────────────────────────────────────────────
    console.log('\nF6 · encolar dos veces la misma inyección');
    {
      const clave = `clover_inject:${SITE}:999001:HASHDUP`;
      const enc = async () => (await supabase.rpc('enqueue_job', {
        p_site_id: SITE, p_queue_name: 'pos_injection', p_job_type: 'order_injection', p_integration: 'clover',
        p_idempotency_key: clave, p_payload: { probe: true }, p_total_steps: 1,
        p_steps: [{ step_name: 'create_order', max_attempts: 1, idempotency_key: `${clave}:s` }],
        p_priority: 1, p_reference_type: 'order', p_reference_id: '999001', p_correlation_id: null,
      })).data;
      const a = await enc(); const b = await enc();
      chk('la misma llave devuelve el MISMO job (no duplica)', a === b, `${a} vs ${b}`);
      await supabase.from('integration_jobs').delete().eq('idempotency_key', clave);
    }

    // ── F7 · límite duro de líneas ───────────────────────────────────────────────────────
    console.log('\nF7 · orden con más de 3000 líneas');
    {
      const oid = await nuevaOrdenMcm([{ n: 'Z', c: 100 }]); basuraMcm.push(oid);
      const tid = await crearTicket(oid); basura.push(tid);
      const muchas = Array.from({ length: 3001 }, (_, i) => ({ name: `L${i}`, price: 1 }));
      let msg = ''; let retryable: any = null;
      try { await reconciliar(oid, tid, muchas, 'F7', 3346); }
      catch (e: any) { msg = String(e?.message ?? ''); retryable = e?.retryable; }
      chk('se rechaza con un mensaje claro', /line item limit exceeded/i.test(msg), msg.slice(0, 70));
      chk('y NO es reintentable (reintentar no lo arregla)', retryable === false);
    }

    // ── F8 · CAS: dos escritores concurrentes sobre la misma orden ───────────────────────
    console.log('\nF8 · dos escritores concurrentes (CAS)');
    {
      const oid = await nuevaOrdenMcm([{ n: 'W', c: 100 }]); basuraMcm.push(oid);
      const { data: antes } = await supabase.from('orders').select('date_updated').eq('id', oid).eq('site_id', SITE).single();
      const viejo = (antes as any).date_updated;
      await supabase.from('orders').update({ date_updated: new Date().toISOString() }).eq('id', oid).eq('site_id', SITE);
      const { data: perdedor } = await supabase.from('orders')
        .update({ total: 99 }).eq('id', oid).eq('site_id', SITE).eq('date_updated', viejo).select('id');
      chk('el escritor con el snapshot viejo NO gana el CAS', (perdedor ?? []).length === 0);
      const { data: fin } = await supabase.from('orders').select('total').eq('id', oid).eq('site_id', SITE).single();
      chk('y el total no se corrompió', Number((fin as any).total) !== 99, `total=${(fin as any).total}`);
    }
  } finally {
    await reset();
    await restaurar();
    await limpiar();
    const { data: comp } = await supabase.from('site_integrations').select('config')
      .eq('id', (fila as any).id).eq('site_id', SITE).single();
    const url = (comp as any)?.config?.apiUrl;
    console.log(`\n  apiUrl del site restaurado a: ${url} ${url === cfgOriginal.apiUrl ? '✓' : '✗ ¡REVISAR!'}`);
  }

  console.log(`\n${'='.repeat(56)}\nRESULTADO: ${ok.length} OK · ${mal.length} FALLAN`);
  if (mal.length) process.exit(1);
})().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
