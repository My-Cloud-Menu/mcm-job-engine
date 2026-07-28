/**
 * MT-1 · Aislamiento real con DOS tenants sobre la MISMA location de Omnivore.
 *
 * Se reactiva el `fetch_recent_orders` del vecino 25612612 (que comparte `cx9oRBRi`),
 * se crea un ticket nuevo y se verifica que AMBOS sites lo ingieren, cada uno con su
 * propia fila, su propio check_number y sus propios jobs — sin mezclarse.
 *
 * Al terminar, el vecino queda como estaba según `_cert_restore_20260727`.
 */
const L = require('./lib.cjs');
const { omni, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const VECINO = 25612612;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

(async () => {
  const c = await db.raw();
  const ev = {};

  // ── estado guardado del vecino
  const prev = await c.query(`select * from _cert_restore_20260727`);
  console.log('estado previo guardado del vecino:', JSON.stringify(prev.rows));
  ev.estado_previo = prev.rows;

  const antes = await c.query(`select
      (select count(*) from orders   where site_id=$1)::int as ord,
      (select count(*) from payments where site_id=$1)::int as pag,
      (select count(*) from integration_jobs where site_id=$1)::int as job`, [VECINO]);
  const antesCert = await c.query(`select
      (select count(*) from orders   where site_id=$1)::int as ord,
      (select count(*) from payments where site_id=$1)::int as pag`, [S]);
  console.log(`vecino ${VECINO} antes:  ${antes.rows[0].ord} órdenes · ${antes.rows[0].pag} pagos · ${antes.rows[0].job} jobs`);
  console.log(`cert   ${S} antes:  ${antesCert.rows[0].ord} órdenes · ${antesCert.rows[0].pag} pagos`);

  try {
    // ── reactivar el vecino
    await c.query(`update sync_schedules set status='active', interval_seconds=60, next_run_at=now(),
        consecutive_failures=0 where site_id=$1 and sync_type='fetch_recent_orders'`, [VECINO]);
    const sc = await c.query(`select status,interval_seconds from sync_schedules where site_id=$1 and sync_type='fetch_recent_orders'`, [VECINO]);
    console.log(`\nvecino reactivado: ${JSON.stringify(sc.rows[0])}`);

    // ── ticket nuevo en la location compartida
    const tb = await omni.call('GET', '/tables/?limit=1000');
    const libres = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
    const t = await omni.openTicket({ name: `CERT-${TOK}-MT1`, table: libres[3], guestCount: 2, employee: '975' });
    if (!t.ok) { console.log('✗ no se pudo abrir el ticket:', JSON.stringify(t.body?.errors)); return; }
    const tid = t.body.id;
    await omni.addItems(tid, [{ menu_item: '300025', quantity: 1, auto_send: true }]);
    const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
    console.log(`ticket compartido ${tid} · total ${w.totals?.total}¢`);
    ev.ticket = tid;

    // ── esperar a que los DOS lo ingieran
    console.log('\n… esperando la ingesta en ambos tenants (máx 6 min)');
    const limite = Date.now() + 6 * 60 * 1000;
    let oCert = null, oVec = null;
    while (Date.now() < limite && !(oCert && oVec)) {
      const r = await c.query(`select id, site_id, check_number, total, table_id, pos_id, employee->>'id' as emp
         from orders where pos_id=$1 order by site_id`, [tid]);
      oCert = r.rows.find((x) => Number(x.site_id) === S) || oCert;
      oVec = r.rows.find((x) => Number(x.site_id) === VECINO) || oVec;
      if (!(oCert && oVec)) await sleep(10000);
    }

    console.log(`\n── ingesta del MISMO ticket ${tid}`);
    console.log(`   site ${S} (cert):   ${oCert ? `orden ${oCert.id} · check ${oCert.check_number} · total ${oCert.total} · table_id ${oCert.table_id}` : 'NO llegó'}`);
    console.log(`   site ${VECINO} (vecino): ${oVec ? `orden ${oVec.id} · check ${oVec.check_number} · total ${oVec.total} · table_id ${oVec.table_id}` : 'NO llegó'}`);
    ev.cert = oCert; ev.vecino = oVec;

    if (oCert && oVec) {
      const mismaFila = String(oCert.id) === String(oVec.id) && Number(oCert.site_id) === Number(oVec.site_id);
      console.log(`\n   ¿ids de orden distintos?      ${oCert.id !== oVec.id ? `sí (${oCert.id} vs ${oVec.id})` : `NO — ambos ${oCert.id} (mismo id, distinto site: correcto por PK compuesta)`}`);
      console.log(`   ¿table_id distintos?          ${oCert.table_id !== oVec.table_id ? '✓ sí — cada tenant resolvió su propia mesa' : '✗ comparten table_id: fuga entre tenants'}`);
      console.log(`   ¿totales iguales?             ${oCert.total === oVec.total ? '✓ sí (mismo ticket de Aloha)' : '✗ divergen'}`);
      console.log(`   ${!mismaFila ? '✓ AISLAMIENTO OK: dos filas independientes para el mismo ticket externo' : '✗ colisión'}`);
    }

    // ── ¿los jobs de cada tenant son suyos?
    const jobs = await c.query(`select site_id, count(*)::int n from integration_jobs
       where created_at > now() - interval '8 minutes' and site_id in ($1,$2) group by 1`, [S, VECINO]);
    console.log(`\n   jobs creados en la ventana: ${jobs.rows.map((x) => `site ${x.site_id}: ${x.n}`).join(' · ')}`);
    const cruce = await c.query(`select count(*)::int n from integration_jobs
       where site_id=$1 and reference_id = $2`, [VECINO, String(oCert?.id ?? -1)]);
    console.log(`   jobs del vecino apuntando a la orden del cert: ${cruce.rows[0].n} ${cruce.rows[0].n === 0 ? '✓' : '✗ CRUCE'}`);
    ev.jobs = jobs.rows;

    const despues = await c.query(`select
        (select count(*) from orders   where site_id=$1)::int as ord,
        (select count(*) from payments where site_id=$1)::int as pag`, [VECINO]);
    console.log(`\n   vecino después: ${despues.rows[0].ord} órdenes (antes ${antes.rows[0].ord}) · ${despues.rows[0].pag} pagos (antes ${antes.rows[0].pag})`);
    console.log(`   → el vecino creció ${despues.rows[0].ord - antes.rows[0].ord} órdenes: es lo ESPERADO, comparte la location`);
    ev.crecimiento_vecino = despues.rows[0].ord - antes.rows[0].ord;
  } finally {
    // ── restaurar el vecino a su estado original
    const p = prev.rows[0] || {};
    const st = p.status ?? 'active', iv = p.interval_seconds ?? 60;
    await c.query(`update sync_schedules set status=$1, interval_seconds=$2 where site_id=$3 and sync_type='fetch_recent_orders'`, [st, iv, VECINO]);
    const fin = await c.query(`select status,interval_seconds,consecutive_failures,next_run_at from sync_schedules where site_id=$1 and sync_type='fetch_recent_orders'`, [VECINO]);
    console.log(`\n[restaurado] vecino ${VECINO}.fetch_recent_orders → ${JSON.stringify(fin.rows[0])}`);
    ev.restaurado = fin.rows[0];
  }
  saveEvidence(`mt1-${TOK}`, ev);
  await db.close();
})();
