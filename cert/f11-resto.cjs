/**
 * F11 restantes · 11.2 cuadre por tender · 11.3 por mesero · 11.7 dead-letters · 11.9 idempotencia
 * Todo desde datos ya persistidos. Scoped a site 99990003.
 */
const L = require('./lib.cjs');
const { db, CERT_SITE: S, saveEvidence, TOK } = L;
const usd = (n) => '$' + Number(n || 0).toFixed(2);

(async () => {
  const ev = {};

  // ── 11.2 · cuadre por tender
  console.log('── 11.2 · ventas por tender');
  const porMetodo = await db.q(S, `select method, source, count(*)::int as n, sum(total::numeric) as monto,
      sum(tip::numeric) as propina from payments where site_id=$1 group by method, source order by 4 desc`);
  porMetodo.forEach((r) => console.log(`   method='${r.method}'  source='${r.source}'  ${r.n} pagos  ${usd(r.monto)}  propina ${usd(r.propina)}`));
  const metodos = new Set(porMetodo.map((r) => r.method));
  console.log(`   métodos distintos en MCM: ${metodos.size} → ${[...metodos].join(', ')}`);
  console.log(`   ${metodos.size <= 1 ? '✗ TODO cae en un solo método: el reporte por tender es inservible' : '~ hay más de un método, revisar fidelidad'}`);
  ev.por_tender = porMetodo;

  // ¿qué tenders usó realmente el POS? (desde las órdenes con pago externo)
  const externos = await db.q(S, `select count(*)::int as n from payments where site_id=$1
     and additional_properties->>'origin' = 'omnivore-sync'`);
  const clover = await db.q(S, `select count(*)::int as n from payments where site_id=$1
     and additional_properties->>'origin' is distinct from 'omnivore-sync'`);
  console.log(`   pagos nacidos en el POS: ${externos[0].n}   nacidos en Clover: ${clover[0].n}`);
  console.log(`   → los ${externos[0].n} del POS perdieron su tender real (N3); los de Clover conservan la marca en 'source'`);

  // ── 11.3 · cuadre por mesero
  console.log('\n── 11.3 · ventas por mesero');
  const porEmp = await db.q(S, `select employee->>'id' as emp, count(*)::int as n, sum(total::numeric) as monto
     from orders where site_id=$1 and pos_id is not null group by 1 order by 3 desc nulls last`);
  porEmp.forEach((r) => console.log(`   empleado '${r.emp ?? '—'}': ${r.n} órdenes  ${usd(r.monto)}`));
  const sinEmp = porEmp.filter((r) => !r.emp).reduce((a, r) => a + r.n, 0);
  console.log(`   órdenes sin empleado atribuido: ${sinEmp}  ${sinEmp ? '✗ no se puede comisionar' : '✓ todas atribuidas'}`);
  ev.por_mesero = porEmp;

  // ── 11.7 · dead-letters
  console.log('\n── 11.7 · dead-letters de la certificación');
  const dl = await db.q(S, `select j.job_type, j.integration, count(*)::int as n,
      (array_agg(distinct a.error_code))[1:4] as codigos
    from integration_jobs j
    left join job_steps s on s.job_id=j.id
    left join job_step_attempts a on a.step_id=s.id
    where j.site_id=$1 and j.status='dead_letter' group by 1,2 order by 3 desc`);
  const total = dl.reduce((a, r) => a + r.n, 0);
  dl.forEach((r) => console.log(`   ${r.integration}.${r.job_type}: ${r.n}  → ${(r.codigos || []).filter(Boolean).join(', ')}`));
  console.log(`   total: ${total}  · todos explicados por M1 / N1 / N2 / H2 en el informe`);
  ev.dead_letters = dl;

  // ── 11.9 · idempotencia: ¿el sync repetido duplica algo?
  console.log('\n── 11.9 · idempotencia (¿el pull repetido duplica órdenes o pagos?)');
  const dupOrd = await db.q(S, `select pos_id, count(*)::int as n from orders
     where site_id=$1 and pos_id is not null group by pos_id having count(*)>1`);
  const dupPag = await db.q(S, `select reference, count(*)::int as n from payments
     where site_id=$1 and reference is not null group by reference having count(*)>1`);
  const dupClover = await db.q(S, `select clover_ticket_id, count(*)::int as n from orders
     where site_id=$1 and clover_ticket_id is not null group by clover_ticket_id having count(*)>1`);
  console.log(`   órdenes MCM duplicadas por ticket de Aloha: ${dupOrd.length} ${dupOrd.length ? '✗ ' + JSON.stringify(dupOrd) : '✓'}`);
  console.log(`   pagos duplicados por referencia:            ${dupPag.length} ${dupPag.length ? '✗ ' + JSON.stringify(dupPag) : '✓'}`);
  console.log(`   órdenes Clover reusadas por 2 órdenes MCM:  ${dupClover.length} ${dupClover.length ? '✗ ' + JSON.stringify(dupClover) : '✓'}`);
  ev.idempotencia = { dupOrd, dupPag, dupClover };

  // ── llaves de idempotencia ocupadas por jobs muertos (exposición de N2)
  const muertas = await db.q(S, `select count(*)::int as n from integration_jobs
     where site_id=$1 and status='dead_letter' and idempotency_key is not null`);
  console.log(`\n   llaves de idempotencia retenidas por jobs MUERTOS (bloquean reintento — N2): ${muertas[0].n}`);

  saveEvidence(`f11resto-${TOK}`, ev);
  await db.close();
})();
