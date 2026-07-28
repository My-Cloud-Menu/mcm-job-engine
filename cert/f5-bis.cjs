/**
 * F5.4 · ¿5 fallos seguidos apagan el schedule, y avisa alguien?
 * F11.bis · ¿cada palanca de apagado hace lo que dice, y en cuánto tiempo?
 *
 * Todo contenido al site 99990003. Cada cambio se restaura al final, pase lo que pase.
 */
const L = require('./lib.cjs');
const { db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const ev = {};
let restaurar = [];

const sched = async (tipo) => (await db.q(S, `select id,sync_type,status,consecutive_failures,interval_seconds,next_run_at,left(last_error,60) as err
   from sync_schedules where site_id=$1 and sync_type=$2`, [tipo]))[0];

async function alertasDesde(ts) {
  return db.q(S, `select dedupe_key,event_type,created_at from alerts_outbox where site_id=$1 and created_at > $2 order by created_at`, [ts]);
}

(async () => {
  const c = await db.raw();
  console.log('═══ F5.4 + F11.bis ═══\n');

  // ── snapshot de la config para restaurar
  const orig = (await db.q(S, `select id, config, active from site_integrations where site_id=$1 and provider='omnivore' and type='pos'`))[0];
  const origClover = (await db.q(S, `select id, config, active from site_integrations where site_id=$1 and provider='clover' and type='pos'`))[0];
  restaurar.push(async () => {
    await c.query(`update site_integrations set config=$1, active=$2 where id=$3`, [orig.config, orig.active, orig.id]);
    await c.query(`update site_integrations set config=$1, active=$2 where id=$3`, [origClover.config, origClover.active, origClover.id]);
  });
  console.log(`config original guardada (omnivore active=${orig.active}, clover active=${origClover.active})\n`);

  try {
    // ══ F5.4 · romper la credencial → 5 fallos → ¿failing? ¿alerta?
    console.log('── F5.4 · 5 fallos consecutivos en fetch_recent_orders');
    const antes = await sched('fetch_recent_orders');
    console.log(`   estado inicial: status=${antes.status} fallos=${antes.consecutive_failures} intervalo=${antes.interval_seconds}s`);
    const t0 = new Date().toISOString();
    const cfgMala = { ...orig.config, apiKey: 'cert-clave-invalida-f54' };
    await c.query(`update site_integrations set config=$1 where id=$2`, [cfgMala, orig.id]);
    await c.query(`update sync_schedules set consecutive_failures=0, status='active', next_run_at=now() where site_id=$1 and sync_type='fetch_recent_orders'`, [S]);
    console.log('   credencial invalidada · esperando los ciclos (la caché de credenciales es de 60 s)…');

    let s = antes, ciclos = 0;
    const limite = Date.now() + 6 * 60 * 1000;
    while (Date.now() < limite) {
      await sleep(15000);
      s = await sched('fetch_recent_orders');
      ciclos++;
      console.log(`   t+${ciclos * 15}s: status=${s.status} fallos=${s.consecutive_failures} ${s.err ? '· ' + s.err : ''}`);
      if (s.status === 'failing') break;
    }
    ev.f54 = { llego_a_failing: s.status === 'failing', fallos: s.consecutive_failures, segundos: ciclos * 15, error: s.err };
    console.log(`   ⇒ ${s.status === 'failing' ? `✓ el schedule quedó en 'failing' tras ${s.consecutive_failures} fallos (${ciclos * 15}s)` : `~ no llegó a failing en 6 min (fallos=${s.consecutive_failures})`}`);

    // ¿alguna alerta menciona que el SYNC se apagó?
    const al = await alertasDesde(t0);
    ev.f54.alertas = al;
    console.log(`   alertas emitidas en la ventana: ${al.length}`);
    al.forEach((a) => console.log(`      ${a.created_at.toISOString()} ${a.event_type} · ${a.dedupe_key}`));
    const hayAlertaDeSchedule = al.some((a) => /schedule|sync/i.test(a.event_type));
    console.log(`   alerta específica de "el sync se apagó": ${hayAlertaDeSchedule ? 'sí' : '✗ NINGUNA'}`);

    // ¿se auto-recupera?
    console.log('   restaurando la credencial y esperando 90 s para ver si revive solo…');
    await c.query(`update site_integrations set config=$1 where id=$2`, [orig.config, orig.id]);
    await sleep(90000);
    const s2 = await sched('fetch_recent_orders');
    ev.f54.revivio_solo = s2.status === 'active';
    console.log(`   ⇒ tras 90 s con la credencial buena: status=${s2.status}  ${s2.status === 'active' ? '✓ revivió solo' : '✗ sigue apagado — requiere intervención manual'}`);

    // ¿trigger_sync_now lo revive?
    const tr = await c.query(`select trigger_sync_now($1,'omnivore','fetch_recent_orders') as r`, [S]);
    await sleep(4000);
    const s3 = await sched('fetch_recent_orders');
    ev.f54.trigger_lo_revive = s3.status === 'active';
    console.log(`   ⇒ tras trigger_sync_now(): status=${s3.status}  ${s3.status === 'active' ? '✓ es el camino de recuperación' : '✗ tampoco'}`);

    // ══ F11.bis · palancas de apagado
    console.log('\n── F11.bis · palancas de apagado');
    const palancas = [];

    // P1 · sync_schedules.status = 'disabled'
    let t = Date.now();
    await c.query(`update sync_schedules set status='disabled' where site_id=$1 and sync_type='push_orders'`, [S]);
    const p1 = await sched('push_orders');
    palancas.push({ palanca: "sync_schedules.status='disabled'", alcance: 'un sync', efecto: p1.status === 'disabled' ? 'inmediato' : 'no aplicó', ms: Date.now() - t });
    console.log(`   P1 sync_schedules.status='disabled' (push_orders) → status=${p1.status}  ${p1.status === 'disabled' ? '✓ inmediato' : '✗'}`);
    await c.query(`update sync_schedules set status='active' where site_id=$1 and sync_type='push_orders'`, [S]);

    // P2 · site_integrations.active = false
    t = Date.now();
    await c.query(`update site_integrations set active=false where id=$1`, [origClover.id]);
    const act = (await db.q(S, `select active from site_integrations where site_id=$1 and provider='clover' and type='pos'`))[0];
    // ¿el schedule sigue activo pese a la integración apagada?
    const sc = await sched('push_orders');
    palancas.push({ palanca: 'site_integrations.active=false', alcance: 'un proveedor', efecto: `active=${act.active}, schedule sigue ${sc.status}`, nota: 'el schedule NO se apaga solo; la credencial falla al usarse (caché 60 s)' });
    console.log(`   P2 site_integrations.active=false (clover) → active=${act.active}, schedule push_orders sigue '${sc.status}'`);
    console.log(`      ⚠ apagar la integración NO apaga su schedule: los jobs se siguen encolando y fallan al pedir credenciales`);
    await c.query(`update site_integrations set active=true where id=$1`, [origClover.id]);

    // P3 · flags de config
    const cfgFlags = { ...origClover.config, sync_orders_to_clover: false };
    await c.query(`update site_integrations set config=$1 where id=$2`, [cfgFlags, origClover.id]);
    const sc2 = await sched('push_orders');
    palancas.push({ palanca: 'config.sync_orders_to_clover=false', alcance: 'una dirección', efecto: `schedule sigue ${sc2.status} hasta re-ejecutar ensure_sync_schedules` });
    console.log(`   P3 config.sync_orders_to_clover=false → schedule sigue '${sc2.status}'`);
    await c.query(`select ensure_sync_schedules($1,'clover',true)`, [S]);
    await sleep(1500);
    const sc3 = await sched('push_orders');
    console.log(`      tras ensure_sync_schedules() → '${sc3.status}'  ${sc3.status !== 'active' ? '✓ la palanca surte efecto al re-provisionar' : '⚠ sigue activo: el flag no apaga el schedule'}`);
    await c.query(`update site_integrations set config=$1 where id=$2`, [origClover.config, origClover.id]);
    await c.query(`select ensure_sync_schedules($1,'clover',true)`, [S]);

    ev.palancas = palancas;
  } finally {
    for (const f of restaurar) { try { await f(); } catch (e) { console.log('  ⚠ fallo al restaurar:', String(e).slice(0, 80)); } }
    await c.query(`update sync_schedules set status='active' where site_id=$1 and status='disabled'`, [S]);
    console.log('\n[restaurado] config y schedules del site de certificación');
    const fin = await db.q(S, `select sync_type,status,consecutive_failures from sync_schedules where site_id=$1 order by sync_type`);
    fin.forEach((x) => console.log(`   ${x.sync_type}: ${x.status} (fallos ${x.consecutive_failures})`));
  }

  saveEvidence(`f5bis-${TOK}`, ev);
  const nb = await L.assertNeighborsIntact('F5/F11bis');
  console.log(`   vecinos intactos: ${nb.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
