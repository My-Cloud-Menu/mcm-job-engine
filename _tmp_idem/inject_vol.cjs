/** Auditoría inyección Omnivore — VOLUMEN/RUSH (I6): ~50 inyecciones concurrentes. */
const L = require('./inject_lib.cjs');
const N = 50;
const pass = [], fail = [], findings = [];
const ok = (n, d) => { pass.push(n); console.log(`✅ ${n} — ${d}`); };
const no = (n, d) => { fail.push(n); findings.push(`[${n}] ${d}`); console.log(`❌ ${n} — ${d}`); };
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : 0; };

(async () => {
  const c = await L.connect(); const cfg = await L.getCfg(c); const ax = L.omniClient(cfg);
  console.log(`\n################ INYECCIÓN — VOLUMEN (N=${N}) ################\n`);
  const { due } = await L.probeDue(ax, cfg);
  const dlBefore = Number((await c.query(`select count(*) n from integration_jobs where status='dead_letter'`)).rows[0].n);

  // crear N órdenes online
  console.log(`creando ${N} órdenes online...`);
  const orders = [];
  for (let i = 0; i < N; i++) { const o = await L.createOnlineOrder(c); orders.push(o.id); }

  // enquela N inyecciones (rush) — casi simultáneo
  console.log(`enquelando ${N} inyecciones...`);
  const t0 = Date.now();
  const jobs = await Promise.all(orders.map((id) => L.enqueueInjection(c, cfg, id, { withPayment: true, amountCents: due }).then((r) => r.jobId)));
  const enqMs = Date.now() - t0;

  // poll hasta que todos terminen (completed/dead_letter)
  console.log(`esperando que los ${N} jobs terminen...`);
  const tProc = Date.now();
  let done = 0;
  while (Date.now() - tProc < 240000) {
    const r = await c.query(`select status, count(*) n from integration_jobs where id = any($1) group by status`, [jobs]);
    const m = Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)]));
    done = (m.completed || 0) + (m.dead_letter || 0);
    process.stdout.write(`\r  completed=${m.completed || 0} dead=${m.dead_letter || 0} running=${m.running || 0} pending=${(m.pending || 0) + (m.retrying || 0)}   `);
    if (done >= N) break;
    await L.sleep(2500);
  }
  const wall = Date.now() - tProc;
  console.log('');

  // métricas por job (created→completed)
  const durs = (await c.query(`select extract(epoch from (completed_at - created_at))*1000 ms from integration_jobs where id=any($1) and completed_at is not null`, [jobs])).rows.map((r) => Math.round(Number(r.ms)));
  const completed = Number((await c.query(`select count(*) n from integration_jobs where id=any($1) and status='completed'`, [jobs])).rows[0].n);
  const dead = Number((await c.query(`select count(*) n from integration_jobs where id=any($1) and status='dead_letter'`, [jobs])).rows[0].n);

  // integridad: cada orden con pos_id distinto, sin duplicados
  const rows = (await c.query(`select id, pos_id, omnivore_pos_id, paid from orders where id=any($1) and site_id=$2`, [orders, L.SITE])).rows;
  const withPos = rows.filter((r) => r.pos_id || r.omnivore_pos_id);
  const posIds = withPos.map((r) => r.pos_id || r.omnivore_pos_id);
  const distinctPos = new Set(posIds);
  const dupTickets = posIds.length - distinctPos.size;
  const paidOk = rows.filter((r) => Number(r.paid) > 0).length;
  const dlAfter = Number((await c.query(`select count(*) n from integration_jobs where status='dead_letter'`)).rows[0].n);
  const qDepth = Number((await c.query(`select count(*) n from integration_jobs where id=any($1) and status in ('pending','retrying','running')`, [jobs])).rows[0].n);

  const metrics = { N, completed, dead, enqueue_ms: enqMs, wall_s: (wall / 1000).toFixed(1), throughput_per_s: (completed / (wall / 1000)).toFixed(2), p50_ms: pct(durs, 50), p95_ms: pct(durs, 95), max_ms: Math.max(...durs, 0), distinct_tickets: distinctPos.size, dup_tickets: dupTickets, paid_ok: paidOk, dead_letter_delta: dlAfter - dlBefore, queue_depth_after: qDepth };
  console.log('MÉTRICAS:', JSON.stringify(metrics, null, 2));

  if (completed === N && distinctPos.size === N && dupTickets === 0 && (dlAfter - dlBefore) === 0)
    ok('I6.volume', `${N} inyecciones → ${N} tickets DISTINTOS, 0 duplicados, 0 dead-letters; ${paidOk} pagadas; wall ${(wall/1000).toFixed(1)}s, p95 ${pct(durs,95)}ms`);
  else if (dupTickets === 0 && distinctPos.size === withPos.length && (dlAfter - dlBefore) === 0)
    no('I6.volume', `0 duplicados pero completed=${completed}/${N} withPos=${withPos.length} (algunas inyecciones no terminaron a tiempo / Aloha lento bajo carga; SIN duplicación)`);
  else
    no('I6.volume', `completed=${completed} distinct=${distinctPos.size} dup=${dupTickets} Δdl=${dlAfter - dlBefore}`);

  // ── CLEANUP ──
  console.log('\n--- cleanup volumen ---');
  let cleaned = 0;
  for (const id of orders) { try { await L.cleanupOrder(c, ax, cfg, id); cleaned++; } catch {} }
  console.log(`cleaned ${cleaned}/${N}`);
  await c.end();
  console.log(`\n===== INYECCIÓN VOLUMEN: ${pass.length} pass / ${fail.length} fail =====`);
  if (findings.length) console.log('HALLAZGOS:\n' + findings.map((f) => '  - ' + f).join('\n'));
  require('fs').writeFileSync(__dirname + '/inject_vol_metrics.json', JSON.stringify(metrics, null, 2));
})().catch((e) => { console.error('FATAL', e.message, e.stack); process.exit(1); });
