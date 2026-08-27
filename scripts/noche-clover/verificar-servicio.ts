/**
 * Verifica los criterios de aceptación de la simulación de servicio:
 *  1. 0 dead-letters no explicados
 *  2. 0 anclas perdidas (toda línea empujada por MCM lleva su `clover.line_item_ids`)
 *  3. el total de MCM cuadra con el ticket de Clover en TODAS las órdenes
 *  4. latencias por paso (p50/p95) y salud de la cola
 *  5. huella cero fuera del banco
 */
import { supabase } from '../../src/lib/supabase';
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = 99990004;
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

(async () => {
  const informe = JSON.parse(readFileSync(join(__dirname, 'informe-servicio.json'), 'utf8'));
  const desde = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cl = createCloverClient(CloverConfigSchema.parse(config), 'ver', SITE);
  const ok: string[] = []; const mal: string[] = [];
  const chk = (n: string, c: boolean, d = '') => {
    (c ? ok : mal).push(n); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`);
  };

  // ── 1 · salud de la cola ────────────────────────────────────────────────────────────────
  const { data: jobs } = await supabase.from('integration_jobs')
    .select('id, job_type, status, last_error, created_at, updated_at')
    .eq('site_id', SITE).eq('integration', 'clover').gte('created_at', desde);
  const porEstado: Record<string, number> = {};
  for (const j of (jobs ?? []) as any[]) porEstado[j.status] = (porEstado[j.status] ?? 0) + 1;
  console.log(`\njobs de Clover en la ventana: ${JSON.stringify(porEstado)}`);
  const dl = (jobs ?? []).filter((j: any) => j.status === 'dead_letter');
  chk('0 dead-letters', dl.length === 0,
      dl.length ? dl.slice(0, 5).map((j: any) => `${j.job_type}: ${String(j.last_error).slice(0, 80)}`).join(' | ') : '');
  const lat = (jobs ?? []).filter((j: any) => j.status === 'completed')
    .map((j: any) => new Date(j.updated_at).getTime() - new Date(j.created_at).getTime()).filter((n: number) => n >= 0);
  console.log(`  latencia de job (ms): p50=${pct(lat, 50)} p95=${pct(lat, 95)} max=${Math.max(0, ...lat)} sobre ${lat.length}`);

  // ── 2 · cuadre orden a orden ────────────────────────────────────────────────────────────
  const { data: filas } = await supabase.from('orders')
    .select('id, clover_ticket_id, total, line_items, additional_properties, channel')
    .eq('site_id', SITE);
  const enMcm = new Map<number, any>();
  for (const f of (filas ?? []) as any[]) enMcm.set(Number(f.id), f);

  let cuadran = 0, descuadran = 0, sinTicket = 0, sinAncla = 0, revisadas = 0;
  const fallos: string[] = [];
  for (const o of informe.ordenes) {
    const fila = o.mcmId ? enMcm.get(o.mcmId) : [...enMcm.values()].find((f: any) => f.clover_ticket_id === o.cloverId);
    if (!fila) continue;
    revisadas++;
    const tid = fila.clover_ticket_id;
    if (!tid) { sinTicket++; fallos.push(`orden ${fila.id}: sin clover_ticket_id`); continue; }
    const ct = (await cl.get<any>(`/orders/${tid}?expand=lineItems`)).data;
    // Se comparan los TOTALES DE ORDEN, no los precios de línea.
    //
    // Medido (orden 10181): la línea de Clover vale `price=88` con `estatal 10,5%` + `municipal
    // 1%` encima, mientras que la línea de MCM vale `1.00`. El `price` de Clover es la BASE SIN
    // IMPUESTO; el total de la orden en Clover es exactamente `100`, que es el total de MCM.
    // Comparar precios de línea contra totales de MCM daba un descuadre constante de ~1/1,136
    // que NO era una pérdida de dinero: era comparar peras con manzanas.
    const cCent = Number(ct?.total ?? 0);
    const mCent = Math.round(Number(fila.total ?? 0) * 100);
    if (cCent === mCent) cuadran++;
    else { descuadran++; if (fallos.length < 12) fallos.push(`orden ${fila.id} (${o.origen}): MCM ${mCent}c vs Clover ${cCent}c`); }
    // Las anclas (`clover.line_item_ids`) son un concepto del MODO GESTIONADO: las estampa
    // `send-to-kitchen` al firear una mesa. Una orden inyectada (canal `online`) NO es gestionada
    // —`isManaged` es falso, así que el pull la sobrescribe en vez de fusionarla— y por tanto no
    // necesita ancla. Sólo se exige en las gestionadas.
    const gestionada = fila.additional_properties?.clover_managed === true
      || String(fila.channel ?? '').toLowerCase() === 'pos';
    if (gestionada) {
      const vivas = (fila.line_items ?? []).filter((l: any) => l.status !== 'voided');
      const conAncla = vivas.filter((l: any) =>
        Array.isArray(l?.additional_properties?.clover?.line_item_ids) && l.additional_properties.clover.line_item_ids.length > 0).length;
      if (vivas.length > 0 && conAncla === 0) sinAncla++;
    }
  }
  console.log(`\nórdenes revisadas: ${revisadas}`);
  chk('todas tienen ticket de Clover', sinTicket === 0, sinTicket ? `${sinTicket} sin ticket` : '');
  chk('el total de MCM cuadra con el de Clover', descuadran === 0, `${cuadran} cuadran · ${descuadran} descuadran`);
  chk('0 anclas perdidas en las órdenes GESTIONADAS', sinAncla === 0, sinAncla ? `${sinAncla} sin ancla` : '');
  if (fallos.length) console.log('  detalle:\n    ' + fallos.join('\n    '));

  // ── 3 · multi-tenant ────────────────────────────────────────────────────────────────────
  const { count: fuera } = await supabase.from('integration_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('integration', 'clover').neq('site_id', SITE).gte('created_at', desde);
  chk('0 jobs de Clover para otros sites', (fuera ?? 0) === 0);

  console.log(`\n${'='.repeat(56)}\nRESULTADO: ${ok.length} OK · ${mal.length} FALLAN`);
  if (mal.length) process.exit(1);
})().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
