/**
 * Simulación de un servicio real de restaurante contra el merchant sandbox de Clover.
 *
 * No llama a los handlers a mano: usa el CAMINO REAL —la edge `sync-orders-to-clover` encola y
 * los workers de `pos_injection` procesan— porque lo que se quiere medir es el sistema, no las
 * funciones sueltas.
 *
 * Uso:  npx tsx scripts/noche-clover/simular-servicio.ts [nOrdenes]
 */
import { supabase } from '../../src/lib/supabase';
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = 99990004;
const N = Number(process.argv[2] ?? 150);
const MESAS = 10;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const azar = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

type Orden = {
  mcmId: number; mesa: number; empleado: string; origen: 'mcm' | 'clover';
  lineas: Array<{ nombre: string; centavos: number }>;
  rareza?: string; cloverId?: string | null; editada?: boolean; anulada?: boolean;
};

async function main() {
  const t0 = Date.now();
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cl = createCloverClient(CloverConfigSchema.parse(config), 'sim', SITE);

  // ── catálogo y empleados reales del banco ───────────────────────────────────────────────
  const { data: prods } = await supabase.from('products')
    .select('id, name, price').eq('site_id', SITE).eq('status', 'published').limit(60);
  const catalogo = (prods ?? []) as any[];
  const { data: emps } = await supabase.from('employees')
    .select('login, first_name').eq('site_id', SITE).eq('role', 'waiter');
  const empleados = (emps ?? []).map((e: any) => e.login);
  console.log(`catálogo: ${catalogo.length} productos · meseros: ${empleados.length} · mesas: ${MESAS}`);
  if (catalogo.length < 5 || empleados.length < 3) throw new Error('el banco no tiene datos suficientes');

  // ── 1 · guion del servicio ──────────────────────────────────────────────────────────────
  const ordenes: Orden[] = [];
  for (let i = 0; i < N; i++) {
    const raro = Math.random() < 0.10;
    let nLineas = 1 + Math.floor(Math.random() * 5);
    let rareza: string | undefined;
    if (raro) {
      const cual = azar(['una-linea', 'cuarenta-lineas', 'precio-cero']);
      rareza = cual;
      if (cual === 'una-linea') nLineas = 1;
      if (cual === 'cuarenta-lineas') nLineas = 40;
    }
    const lineas = Array.from({ length: nLineas }, () => {
      const p = azar(catalogo);
      const centavos = rareza === 'precio-cero' ? 0 : Math.max(0, Math.round(Number(p.price) * 100));
      return { nombre: String(p.name).slice(0, 60), centavos };
    });
    ordenes.push({
      mcmId: 0, mesa: 1 + (i % MESAS), empleado: azar(empleados),
      origen: Math.random() < 0.6 ? 'mcm' : 'clover', lineas, rareza,
    });
  }
  const porOrigen = ordenes.reduce((a, o) => ({ ...a, [o.origen]: (a as any)[o.origen] + 1 }), { mcm: 0, clover: 0 } as any);
  const raras = ordenes.filter((o) => o.rareza).length;
  console.log(`guion: ${N} órdenes · ${porOrigen.mcm} nacen en MCM · ${porOrigen.clover} nacen en el terminal · ${raras} raras`);

  // ── 2 · nacimiento ──────────────────────────────────────────────────────────────────────
  const tNacer = Date.now();
  // Tasa real del merchant para `standard`: estatal 10,5 % + municipal 1 % = 11,5 %.
  // Hay que construir las órdenes con el impuesto YA calculado, como haría el calculador de MCM:
  // `total = subtotal + total_tax`. Con `total_tax: 0` y `tax_class: 'standard'` el ticket de
  // Clover queda 11,5 % por encima del `order.total` autoritativo, el delta supera los 100
  // centavos que el reconciliador absorbe, y **con razón NO lo enmascara** (un delta grande sería
  // un ítem perdido o un descuento no aplicado). Era un fallo del guion, no del sistema.
  const TASA = 0.115;
  for (const [i, o] of ordenes.entries()) {
    const baseCent = o.lineas.reduce((s, l) => s + l.centavos, 0);
    const taxCent = Math.round(baseCent * TASA);
    const subtotal = baseCent / 100;
    const total = (baseCent + taxCent) / 100;
    if (o.origen === 'mcm') {
      const { data, error } = await supabase.from('orders').insert({
        site_id: SITE, channel: 'online', status: 'in-kitchen', payment_status: 'not_fulfilled',
        currency: 'USD', employee: { id: o.empleado },
        line_items: o.lineas.map((l, k) => ({
          id: `s${i}-${k}`, product_id: '', name: l.nombre, price: (l.centavos / 100).toFixed(2),
          quantity: 1, notes: '', status: 'sent', total: (l.centavos / 100).toFixed(2),
          total_tax: (Math.round(l.centavos * TASA) / 100).toFixed(2),
          tax_class: 'standard', attributes: [], additional_properties: {},
        })),
        subtotal, total, total_tax: taxCent / 100, paid: 0, discount_total: 0, shipping_total: 0, fee_total: 0,
        additional_properties: { sim_mesa: o.mesa, sim_rareza: o.rareza ?? null },
        date_created: new Date().toISOString(), date_updated: new Date().toISOString(),
      }).select('id').single();
      if (error) throw new Error(`insert orden ${i}: ${error.message}`);
      o.mcmId = Number((data as any).id);
    } else {
      const co = (await cl.post<any>('/orders', {
        title: `Mesa ${o.mesa}`, state: 'Open', currency: 'USD',
      })).data;
      o.cloverId = co.id;
      for (const l of o.lineas) {
        await cl.post(`/orders/${co.id}/line_items`, { name: l.nombre, price: l.centavos });
      }
    }
    if ((i + 1) % 25 === 0) console.log(`  ...${i + 1}/${N} nacidas (${Math.round((Date.now() - tNacer) / 1000)}s)`);
  }
  const msNacer = Date.now() - tNacer;
  console.log(`nacimiento: ${msNacer} ms`);

  // ── 3 · empujar las de MCM por el camino real (edge + cola + workers) ────────────────────
  const tPush = Date.now();
  const url = `${process.env.SUPABASE_URL}/functions/v1/sync-orders-to-clover`;
  let vueltas = 0, encoladoTotal = 0;
  for (;;) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ site_id: SITE }),
    });
    const j: any = await r.json();
    vueltas++; encoladoTotal += Number(j?.enqueued ?? 0);
    const { count } = await supabase.from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('site_id', SITE).is('clover_ticket_id', null).eq('channel', 'online');
    console.log(`  push #${vueltas}: enqueued=${j?.enqueued} failed=${j?.failed} · sin ticket todavía: ${count}`);
    if ((count ?? 0) === 0 || vueltas >= 25) break;
    await dormir(6000);
  }
  const msPush = Date.now() - tPush;

  // ── 4 · pull de las nacidas en el terminal ──────────────────────────────────────────────
  const tPull = Date.now();
  const { getHandler } = await import('../../src/handlers/registry');
  await import('../../src/handlers/clover/sync/fetch-open-orders');
  const sched = (await supabase.from('sync_schedules').select('id')
    .eq('site_id', SITE).eq('sync_type', 'fetch_open_orders').single()).data as any;
  const pull: any = await getHandler('clover', 'fetch_open_orders')!({
    stepInput: { schedule_id: sched.id, cursor: null }, context: {},
    job: { id: 'sim', site_id: SITE, correlation_id: 'sim' } as any,
    step: { idempotency_key: 'sim', attempt_count: 0, max_attempts: 1 } as any,
  } as any);
  const msPull = Date.now() - tPull;
  console.log(`pull: ${JSON.stringify(pull)} en ${msPull} ms`);

  // ── 5 · ediciones y anulaciones a mitad de servicio ─────────────────────────────────────
  const tEdit = Date.now();
  let editadas = 0, anuladas = 0;
  for (const o of ordenes) {
    if (o.origen !== 'clover' || !o.cloverId) continue;
    if (Math.random() < 0.4) {                      // el mesero añade en el terminal
      const p = azar(catalogo);
      await cl.post(`/orders/${o.cloverId}/line_items`,
        { name: String(p.name).slice(0, 60), price: Math.round(Number(p.price) * 100) });
      o.editada = true; editadas++;
    }
    if (Math.random() < 0.15) {                     // y anula otra
      const ls = (await cl.get<any>(`/orders/${o.cloverId}?expand=lineItems`)).data?.lineItems?.elements ?? [];
      if (ls.length > 1) { await cl.delete(`/orders/${o.cloverId}/line_items/${ls[0].id}`); o.anulada = true; anuladas++; }
    }
  }
  const msEdit = Date.now() - tEdit;
  console.log(`ediciones: ${editadas} añadidos · ${anuladas} anulaciones en ${msEdit} ms`);

  // segundo pull, para que el merge absorba las ediciones del terminal
  const pull2: any = await getHandler('clover', 'fetch_open_orders')!({
    stepInput: { schedule_id: sched.id, cursor: null }, context: {},
    job: { id: 'sim2', site_id: SITE, correlation_id: 'sim' } as any,
    step: { idempotency_key: 'sim2', attempt_count: 0, max_attempts: 1 } as any,
  } as any);
  console.log(`pull tras ediciones: ${JSON.stringify(pull2)}`);

  const informe = {
    n: N, mesas: MESAS, empleados: empleados.length, porOrigen, raras,
    ms: { nacer: msNacer, push: msPush, pull: msPull, editar: msEdit, total: Date.now() - t0 },
    pushVueltas: vueltas, encoladoTotal, editadas, anuladas,
    ordenes: ordenes.map((o) => ({ mcmId: o.mcmId, cloverId: o.cloverId, origen: o.origen,
      mesa: o.mesa, empleado: o.empleado, rareza: o.rareza ?? null, lineas: o.lineas.length,
      centavos: o.lineas.reduce((s, l) => s + l.centavos, 0), editada: !!o.editada, anulada: !!o.anulada })),
  };
  const dest = join(__dirname, 'informe-servicio.json');
  writeFileSync(dest, JSON.stringify(informe, null, 2));
  console.log(`\ninforme -> ${dest}`);
  console.log(`TOTAL: ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
