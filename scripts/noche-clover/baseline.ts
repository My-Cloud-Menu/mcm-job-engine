/**
 * Baseline de la noche Clover (2026-08-27). Se corre al cerrar CADA fase.
 *
 * Captura las invariantes que NO deben moverse mientras se trabaja en el banco 99990004:
 * la configuración de Omnivore y Borinqueña, los dead-letters de Omnivore, la huella de
 * Clover fuera del banco, y una huella por tenant de todos los demás sites.
 *
 * Uso:  npx tsx scripts/noche-clover/baseline.ts capturar <etiqueta>
 *       npx tsx scripts/noche-clover/baseline.ts comparar  <etiqueta-previa> <etiqueta-nueva>
 *
 * Salida distinta de 0 si algo se movió → la fase no debe avanzar.
 */
import { supabase } from '../../src/lib/supabase';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BANCO = 99990004;
const DIR = join(__dirname, 'baselines');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Lee TODAS las filas paginando: PostgREST corta en 1000 en silencio. */
async function todas(tabla: string, cols: string, filtro?: (q: any) => any): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    let q = supabase.from(tabla).select(cols).order('site_id', { ascending: true }).range(desde, desde + 999);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tabla}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function capturar() {
  // 1 · Config de integraciones de Omnivore + las 5 filas de Borinqueña
  const si = await todas('site_integrations', 'id, site_id, type, provider, active');
  const ss = await todas('sync_schedules', 'id, site_id, integration, sync_type, status, interval_seconds');
  const omni = si.filter(r => r.provider === 'omnivore')
    .map(r => `SI:${r.id}:${r.site_id}:${r.type}:${r.provider}:${r.active}`);
  const omniSched = ss.filter(r => r.integration === 'omnivore')
    .map(r => `SS:${r.id}:${r.site_id}:${r.sync_type}:${r.status}:${r.interval_seconds}`);
  const bor = si.filter(r => r.site_id === 2647924)
    .map(r => `BOR:${r.id}:${r.type}:${r.provider}:${r.active}`);
  const checksumOmnivore = md5([...omni, ...omniSched, ...bor].sort().join('|'));

  // 1b · El mismo checksum, desglosado por site. El global cambia si alguien conecta Omnivore a
  // un site NUEVO desde el dashboard — pasó el 27-ago con «Numen» (1173690) — y entonces el
  // comparador acusaba a todo Omnivore de haberse movido. Con el desglose se ve al culpable.
  const porSiteOmnivore: Record<string, string> = {};
  for (const sid of new Set([...omni, ...omniSched].map(l => l.split(':')[2]))) {
    porSiteOmnivore[sid] = md5(
      [...omni, ...omniSched].filter(l => l.split(':')[2] === sid).sort().join('|'),
    );
  }

  // 2 · Dead-letters por integración
  const dlRows = await todas('integration_jobs', 'integration, status', q => q.eq('status', 'dead_letter'));
  const deadLetters: Record<string, number> = {};
  for (const r of dlRows) deadLetters[r.integration] = (deadLetters[r.integration] ?? 0) + 1;

  // 3 · Huella de Clover FUERA del banco
  const ordersFuera = await todas('orders', 'site_id, id, additional_properties, line_items',
    q => q.neq('site_id', BANCO));
  let huellaManaged = 0, huellaAnclas = 0;
  for (const o of ordersFuera) {
    const ap = typeof o.additional_properties === 'string'
      ? (() => { try { return JSON.parse(o.additional_properties); } catch { return {}; } })()
      : (o.additional_properties ?? {});
    if (ap && ('clover_managed' in ap || 'clover_synced_at' in ap)) huellaManaged++;
    for (const li of (Array.isArray(o.line_items) ? o.line_items : [])) {
      if (li?.additional_properties?.clover?.line_item_ids) { huellaAnclas++; break; }
    }
  }

  // 4 · Huella POR TENANT (todos menos el banco): conteos que delatarían una escritura cruzada
  const porTenant: Record<string, string> = {};
  const cuenta = async (tabla: string) => {
    const filas = await todas(tabla, 'site_id', q => q.neq('site_id', BANCO));
    const m: Record<number, number> = {};
    for (const f of filas) m[f.site_id] = (m[f.site_id] ?? 0) + 1;
    return m;
  };
  const [ord, prod, emp, ing, cat] = await Promise.all([
    cuenta('orders'), cuenta('products'), cuenta('employees'), cuenta('ingredients'), cuenta('categories'),
  ]);
  const sites = new Set([...Object.keys(ord), ...Object.keys(prod), ...Object.keys(emp), ...Object.keys(ing), ...Object.keys(cat)]);
  for (const s of [...sites].sort()) {
    porTenant[s] = `o=${ord[+s] ?? 0} p=${prod[+s] ?? 0} e=${emp[+s] ?? 0} i=${ing[+s] ?? 0} c=${cat[+s] ?? 0}`;
  }

  // 5 · Estado del banco (informativo, SE ESPERA que cambie)
  const banco = {
    orders: (await todas('orders', 'id', q => q.eq('site_id', BANCO))).length,
    products: (await todas('products', 'id', q => q.eq('site_id', BANCO))).length,
    employees: (await todas('employees', 'id', q => q.eq('site_id', BANCO))).length,
    ingredients: (await todas('ingredients', 'id', q => q.eq('site_id', BANCO))).length,
    categories: (await todas('categories', 'id', q => q.eq('site_id', BANCO))).length,
  };

  return {
    ts: new Date().toISOString(),
    checksumOmnivore,
    porSiteOmnivore,
    checksumTenants: md5(JSON.stringify(porTenant)),
    porTenant,
    deadLetters,
    huellaCloverFuera: { managed: huellaManaged, anclas: huellaAnclas },
    banco,
  };
}

(async () => {
  const [modo, a, b] = process.argv.slice(2);
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

  if (modo === 'capturar') {
    const snap = await capturar();
    writeFileSync(join(DIR, `${a}.json`), JSON.stringify(snap, null, 2));
    console.log(`baseline "${a}" capturado`);
    console.log(`  checksum Omnivore+Borinqueña : ${snap.checksumOmnivore}`);
    console.log(`  checksum de los otros tenants: ${snap.checksumTenants} (${Object.keys(snap.porTenant).length} sites)`);
    console.log(`  dead-letters                 : ${JSON.stringify(snap.deadLetters)}`);
    console.log(`  huella Clover fuera del banco: ${JSON.stringify(snap.huellaCloverFuera)}`);
    console.log(`  banco                        : ${JSON.stringify(snap.banco)}`);
    return;
  }

  if (modo === 'comparar') {
    const prev = JSON.parse(readFileSync(join(DIR, `${a}.json`), 'utf8'));
    const snap = await capturar();
    writeFileSync(join(DIR, `${b}.json`), JSON.stringify(snap, null, 2));
    const fallos: string[] = [];
    const chk = (nombre: string, x: unknown, y: unknown) => {
      const ok = JSON.stringify(x) === JSON.stringify(y);
      console.log(`  ${ok ? '✓' : '✗'} ${nombre}`);
      if (!ok) fallos.push(`${nombre}\n      antes: ${JSON.stringify(x)}\n      ahora: ${JSON.stringify(y)}`);
    };
    console.log(`comparando "${a}" → "${b}"`);
    chk('checksum Omnivore + Borinqueña', prev.checksumOmnivore, snap.checksumOmnivore);
    // Si el global cambió, se dice CUÁL site lo movió y si alguno de los de antes se tocó — que es
    // la única pregunta que importa. Un site nuevo conectado desde el dashboard mueve el global
    // sin que nada existente se haya alterado.
    if (prev.checksumOmnivore !== snap.checksumOmnivore) {
      const antes = prev.porSiteOmnivore ?? {};
      const nuevos = Object.keys(snap.porSiteOmnivore).filter(s => !(s in antes));
      const idos = Object.keys(antes).filter(s => !(s in snap.porSiteOmnivore));
      const alterados = Object.keys(antes).filter(
        s => s in snap.porSiteOmnivore && antes[s] !== snap.porSiteOmnivore[s],
      );
      if (nuevos.length) console.log(`      · sites de Omnivore NUEVOS (no los tocamos): ${nuevos.join(', ')}`);
      if (idos.length) console.log(`      · sites de Omnivore que DESAPARECIERON: ${idos.join(', ')}`);
      console.log(`      · ${alterados.length === 0 ? '✓ ninguno de los sites previos se alteró' : '✗ ALTERADOS: ' + alterados.join(', ')}`);
      // Un site nuevo no es un fallo: lo que se afirma es que NADA de lo que ya existía se movió.
      if (alterados.length === 0) {
        const i = fallos.findIndex(f => f.startsWith('checksum Omnivore'));
        if (i >= 0) fallos.splice(i, 1);
      }
    }
    chk('huella de Clover fuera del banco', prev.huellaCloverFuera, snap.huellaCloverFuera);
    chk('dead-letters de Omnivore', prev.deadLetters.omnivore ?? 0, snap.deadLetters.omnivore ?? 0);
    // por tenant, detallado: qué site cambió y en qué
    const cambios: string[] = [];
    for (const s of new Set([...Object.keys(prev.porTenant), ...Object.keys(snap.porTenant)])) {
      if (prev.porTenant[s] !== snap.porTenant[s]) cambios.push(`site ${s}: "${prev.porTenant[s]}" → "${snap.porTenant[s]}"`);
    }
    console.log(`  ${cambios.length === 0 ? '✓' : '✗'} los otros ${Object.keys(snap.porTenant).length} tenants intactos`);
    if (cambios.length) fallos.push('tenants movidos:\n      ' + cambios.join('\n      '));

    console.log(`\n  banco (se espera que cambie): ${JSON.stringify(prev.banco)} → ${JSON.stringify(snap.banco)}`);
    if (fallos.length) { console.log(`\n✗ ${fallos.length} INVARIANTE(S) ROTA(S):\n    ` + fallos.join('\n    ')); process.exit(1); }
    console.log('\n✓ todas las invariantes se mantienen');
    return;
  }
  console.log('uso: baseline.ts capturar <etiqueta> | comparar <previa> <nueva>');
  process.exit(2);
})().catch(e => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
