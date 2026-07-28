/**
 * F6 · Jornada de volumen · F8 · latencia
 *
 * Simula un servicio real: N mesas abiertas por varios meseros, con ítems variados,
 * respetando el límite de concurrencia 8 de Omnivore (migración 023). Mide la cadena
 * completa y responde la pregunta de producto de F8:
 *
 *    ¿cuánto tarda un ticket de Aloha en ser COBRABLE en el Clover Flex?
 *
 * Uso: node f6.cjs [nOrdenes] [concurrencia]
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

const N = Number(process.argv[2] || 25);
const CONC = Number(process.argv[3] || 6);          // < 8 (límite de Omnivore)
// Espaciado entre aperturas de mesa. Un servicio real NO abre 80 mesas en 25 s;
// sin esto la ráfaga satura el pipeline y la latencia medida sale inflada por el
// encolamiento, no por la arquitectura. Con espaciado se mide el caso realista.
const PACE = Number(process.argv[4] || 8000);
const MESEROS = ['975'];
const CARTA = [
  { menu_item: '300015', precio: 600 },   // Chips & Salsa
  { menu_item: '300025', precio: 1300 },  // Elote
  { menu_item: '300155', precio: 500 },   // Arroz Verde
  { menu_item: '310170', precio: 900 },   // Codorniu
];
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const seg = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + 's');

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  if (libres.length < N) { console.log(`✗ solo ${libres.length} mesas libres para ${N} órdenes`); await db.close(); return; }
  console.log(`═══ F6 · ${N} órdenes · concurrencia ${CONC} · ${libres.length} mesas libres ═══\n`);

  const casos = Array.from({ length: N }, (_, i) => ({
    idx: i, mesa: libres[i], mesero: MESEROS[i % MESEROS.length],
    items: Array.from({ length: 1 + (i % 3) }, (_, k) => ({ ...CARTA[(i + k) % CARTA.length], quantity: 1, auto_send: true })),
  }));

  const res = [];
  let cursor = 0;
  const t0 = Date.now();

  // El monitor corre EN PARALELO a la creación: así cada ticket se cronometra desde
  // su propio instante de cierre, no desde el final de la ráfaga.
  const pend = new Map();
  let creando = true;
  async function monitor() {
    while (creando || pend.size) {
      if (pend.size) {
        const rows = await db.q(S, `select id, pos_id, clover_ticket_id, total
          from orders where site_id=$1 and pos_id = any($2)`, [[...pend.keys()]]);
        for (const o of rows) {
          const r = pend.get(o.pos_id); if (!r) continue;
          if (!r.mcm_id) { r.mcm_id = o.id; r.ms_a_mcm = Date.now() - r.t_pos_listo; }
          if (o.clover_ticket_id) {
            r.clover_id = o.clover_ticket_id;
            r.ms_a_clover = Date.now() - r.t_pos_listo;
            r.mcm_total = Math.round(Number(o.total) * 100);
            pend.delete(o.pos_id);
          }
        }
      }
      await sleep(4000);
    }
  }

  async function worker(wid) {
    while (true) {
      const c = casos[cursor++];
      if (!c) return;
      const r = { idx: c.idx, mesa: c.mesa, mesero: c.mesero };
      try {
        const tA = Date.now();
        const t = await omni.openTicket({ name: `CERT-${TOK}-V${c.idx}`, table: c.mesa, guestCount: 1 + (c.idx % 4), employee: c.mesero });
        if (!t.ok) { r.error = t.body?.errors?.[0]?.error || t.status; res.push(r); console.log(`   x #${c.idx}: ${r.error}`); await sleep(PACE); continue; }
        r.ticket = t.body.id;
        const ai = await omni.addItems(r.ticket, c.items.map(({ menu_item, quantity, auto_send }) => ({ menu_item, quantity, auto_send })));
        if (!ai.ok) { r.error = ai.body?.errors?.[0]?.error; res.push(r); console.log(`   x #${c.idx}: ${r.error}`); await sleep(PACE); continue; }
        const w = await omni.waitTotals(r.ticket, 0, { timeoutMs: 30000 });
        r.pos_total = w.totals?.total ?? null;
        r.t_pos_listo = Date.now();                 // el mesero ya cerró la mesa en Aloha
        r.ms_crear = r.t_pos_listo - tA;
        res.push(r);
        if (r.pos_total) pend.set(r.ticket, r);
        console.log(`   ok #${c.idx} ${r.ticket} ${r.pos_total}c (${r.ms_crear}ms) ${res.length}/${N} en vuelo:${pend.size}`);
        await sleep(PACE);                          // ritmo de un servicio real
      } catch (e) { r.error = String(e).slice(0, 80); res.push(r); await sleep(PACE); }
    }
  }
  const mon = monitor();
  await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
  creando = false;
  const okCreadas = res.filter((r) => r.ticket && r.pos_total);
  console.log(`creadas en Aloha: ${okCreadas.length}/${N}  (${((Date.now() - t0) / 1000).toFixed(0)}s, ritmo ${PACE / 1000}s entre mesas × ${CONC} meseros)`);
  const fallos = res.filter((r) => r.error);
  if (fallos.length) { console.log(`fallos de creación: ${fallos.length}`); const g = {}; fallos.forEach((f) => g[f.error] = (g[f.error] || 0) + 1); Object.entries(g).forEach(([k, v]) => console.log(`   ${k}: ${v}`)); }

  // ── el monitor sigue drenando lo que quedó en vuelo
  console.log(`\n… drenando ${pend.size} en vuelo (máx 8 min)`);
  const limite = Date.now() + 8 * 60 * 1000;
  while (pend.size && Date.now() < limite) await sleep(4000);
  pend.clear();
  await mon;

  const listas = okCreadas.filter((r) => r.clover_id);
  const soloMcm = okCreadas.filter((r) => r.mcm_id && !r.clover_id);
  const nada = okCreadas.filter((r) => !r.mcm_id);

  console.log(`\n── F6 · resultado`);
  console.log(`   cobrables en Clover: ${listas.length}/${okCreadas.length}`);
  console.log(`   llegaron a MCM pero no a Clover: ${soloMcm.length}${soloMcm.length ? ' → ' + soloMcm.map((r) => r.mcm_id).join(', ') : ''}`);
  console.log(`   nunca llegaron a MCM: ${nada.length}${nada.length ? ' → ' + nada.map((r) => r.ticket).join(', ') : ''}`);
  const desc = listas.filter((r) => r.pos_total !== r.mcm_total);
  console.log(`   descuadres POS vs MCM: ${desc.length}${desc.length ? ' → ' + desc.map((r) => `${r.mcm_id}(${r.pos_total}≠${r.mcm_total})`).join(', ') : ''}`);

  console.log(`\n── F8 · latencia: cheque cerrado en Aloha → orden cobrable en el Flex`);
  const aMcm = listas.map((r) => r.ms_a_mcm).filter(Number.isFinite);
  const aCl = listas.map((r) => r.ms_a_clover).filter(Number.isFinite);
  console.log(`   Aloha → MCM      p50 ${seg(pct(aMcm, .5))}  p95 ${seg(pct(aMcm, .95))}  máx ${seg(Math.max(...aMcm))}`);
  console.log(`   Aloha → Clover   p50 ${seg(pct(aCl, .5))}  p95 ${seg(pct(aCl, .95))}  máx ${seg(Math.max(...aCl))}`);
  const p95 = pct(aCl, .95);
  console.log(`\n   Criterio del plan: si el p95 supera ~30 s, "cobrar en la mesa" no es viable con polling.`);
  console.log(`   → p95 = ${seg(p95)}  ⇒  ${p95 > 30000 ? '✗ NO CUMPLE' : '✓ cumple'}`);

  const dl = await db.q(S, `select count(*)::int as n from integration_jobs where site_id=$1 and status='dead_letter' and created_at > now() - interval '20 minutes'`);
  console.log(`\n   dead-letters durante la jornada: ${dl[0].n}`);
  saveEvidence(`f6-${TOK}`, { n: N, concurrencia: CONC, casos: res });
  const nb = await L.assertNeighborsIntact('F6');
  console.log(`   vecinos intactos: ${nb.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
