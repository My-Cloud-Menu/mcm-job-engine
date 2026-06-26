/** Auditoría inyección Omnivore — funcional (I1,I2/I7,I9,I3,I4,I5,I10). */
const L = require('./inject_lib.cjs');
const pass = [], fail = [], findings = [];
const ok = (n, d) => { pass.push(n); console.log(`✅ ${n} — ${d}`); };
const no = (n, d) => { fail.push(n); findings.push(`[${n}] ${d}`); console.log(`❌ ${n} — ${d}`); };

// Simula un retry REAL: el paso objetivo Y todos los posteriores vuelven a 'pending'
// (en un fallo real los pasos siguientes nunca llegaron a 'completed') → así el complete_step
// del ÚLTIMO paso re-dispara el "job completed". Resetear solo 1 paso intermedio deja el job
// colgado en 'running' (artefacto de test, no de la integración).
async function resetStepAndRequeue(c, jobId, stepName, { attempt = 0, clearPosId = null } = {}) {
  const idx = (await c.query(`select step_index from job_steps where job_id=$1 and step_name=$2`, [jobId, stepName])).rows[0].step_index;
  await c.query(`update job_steps set status='pending' where job_id=$1 and step_index>=$2`, [jobId, idx]);
  if (attempt) await c.query(`update job_steps set attempt_count=$3 where job_id=$1 and step_name=$2`, [jobId, stepName, attempt]);
  if (clearPosId) await c.query(`update orders set pos_id=null, omnivore_pos_id=null, global_pos_id=null where id=$1 and site_id=$2`, [clearPosId, L.SITE]);
  await c.query(`update integration_jobs set status='pending', current_step=$2, current_step_name=$3, locked_by=null, locked_until=null, scheduled_for=now() where id=$1`, [jobId, idx, stepName]);
}

(async () => {
  const c = await L.connect();
  const cfg = await L.getCfg(c);
  const ax = L.omniClient(cfg);
  const orders = [];
  const track = (id) => { orders.push(id); return id; };

  console.log('\n################ INYECCIÓN — FUNCIONAL ################\n');
  const { due } = await L.probeDue(ax, cfg);
  console.log(`due de 1× Chips&Salsa = ${due} centavos\n`);

  // ── I1: inyección simple completa ──
  {
    const o = await L.createOnlineOrder(c); track(o.id);
    const { jobId } = await L.enqueueInjection(c, cfg, o.id, { withPayment: true, amountCents: due });
    const j = await L.waitJob(c, jobId);
    const row = await L.orderRow(c, o.id);
    const tid = row?.pos_id || row?.omnivore_pos_id;
    const items = tid ? await L.ticketItems(ax, tid) : -1;
    const t = tid ? await L.ticketTotals(ax, tid) : null;
    if (j.status === 'completed' && tid && items === 1 && t?.paid > 0) ok('I1.simple', `job completed; ticket ${tid}, 1 ítem, pagado (paid=${t.paid}); orders.pos_id seteado`);
    else no('I1.simple', `status=${j.status} tid=${tid} items=${items} paid=${t?.paid} err=${j.last_error}`);
  }

  // ── I2 + I7: doble-enqueue / flapping (misma llave N veces) ──
  {
    const o = await L.createOnlineOrder(c); track(o.id);
    const ids = [];
    for (let i = 0; i < 5; i++) { const { jobId } = await L.enqueueInjection(c, cfg, o.id, { withPayment: true, amountCents: due }); ids.push(jobId); }
    const uniqueJobs = new Set(ids.map(String));
    const j = await L.waitJob(c, ids[0]);
    const row = await L.orderRow(c, o.id); const tid = row?.pos_id || row?.omnivore_pos_id;
    const items = tid ? await L.ticketItems(ax, tid) : -1;
    const jobCount = Number((await c.query(`select count(*) n from integration_jobs where reference_id=$1 and site_id=$2 and job_type='order_injection'`, [String(o.id), L.SITE])).rows[0].n);
    if (uniqueJobs.size === 1 && jobCount === 1 && items === 1) ok('I2/I7.flapping', `5 enqueues misma llave → 1 job (${jobCount}), 1 ticket/1 ítem (dedup enqueue_job)`);
    else no('I2/I7.flapping', `uniqueJobs=${uniqueJobs.size} jobCount=${jobCount} items=${items}`);
  }

  // ── I9: re-enqueue tras inyección OK (pos_id seteado) ──
  {
    const o = await L.createOnlineOrder(c); track(o.id);
    const { jobId } = await L.enqueueInjection(c, cfg, o.id, { withPayment: true, amountCents: due });
    await L.waitJob(c, jobId);
    const row1 = await L.orderRow(c, o.id); const tid = row1?.pos_id || row1?.omnivore_pos_id;
    const items1 = tid ? await L.ticketItems(ax, tid) : -1;
    // re-enqueue misma llave (simula trigger re-disparado)
    const { jobId: jobId2 } = await L.enqueueInjection(c, cfg, o.id, { withPayment: true, amountCents: due });
    await L.sleep(3000);
    const items2 = tid ? await L.ticketItems(ax, tid) : -1;
    const jobCount = Number((await c.query(`select count(*) n from integration_jobs where reference_id=$1 and site_id=$2 and job_type='order_injection'`, [String(o.id), L.SITE])).rows[0].n);
    if (String(jobId2) === String(jobId) && jobCount === 1 && items2 === items1) ok('I9.reEnqueueAfterOk', `re-enqueue tras pos_id → MISMO job (sin 2º), ticket estable (${items1}→${items2} ítems)`);
    else no('I9.reEnqueueAfterOk', `job=${jobId} job2=${jobId2} jobCount=${jobCount} items ${items1}→${items2}`);
  }

  // ── I3: retry de create_order → scan Aloha adopta (mismo ticket, sin 2º) ──
  {
    const o = await L.createOnlineOrder(c); track(o.id);
    const { jobId } = await L.enqueueInjection(c, cfg, o.id, { withPayment: false }); // sin pago → ticket abierto/escaneable
    await L.waitJob(c, jobId);
    const row0 = await L.orderRow(c, o.id);
    const tid0 = row0?.pos_id || row0?.omnivore_pos_id;
    const items0 = tid0 ? await L.ticketItems(ax, tid0) : -1;
    // simular crash de create_order ANTES de persistir pos_id: reset (este + siguientes) + limpiar pos_id + attempt>0
    await resetStepAndRequeue(c, jobId, 'create_order', { attempt: 1, clearPosId: o.id });
    const j = await L.waitJob(c, jobId);
    const row1 = await L.orderRow(c, o.id);
    const tid1 = row1?.pos_id || row1?.omnivore_pos_id;
    const items1 = tid1 ? await L.ticketItems(ax, tid1) : -1;
    if (j.status === 'completed' && tid1 && tid1 === tid0 && items1 === items0) ok('I3.createOrderRetryScan', `retry create_order: scan ADOPTÓ el MISMO ticket (${tid0}), sin 2º; ítems estable (${items0}→${items1})`);
    else no('I3.createOrderRetryScan', `status=${j.status} tid ${tid0}→${tid1} items ${items0}→${items1} err=${j.last_error}`);
  }

  // ── I4: retry de add_items → skip (getTicketItemCount>0) ──
  {
    const o = await L.createOnlineOrder(c); track(o.id);
    const { jobId } = await L.enqueueInjection(c, cfg, o.id, { withPayment: false });
    await L.waitJob(c, jobId);
    const row = await L.orderRow(c, o.id); const tid = row?.pos_id || row?.omnivore_pos_id;
    const before = tid ? await L.ticketItems(ax, tid) : -1;
    await resetStepAndRequeue(c, jobId, 'add_items');
    const j = await L.waitJob(c, jobId);
    const after = tid ? await L.ticketItems(ax, tid) : -1;
    if (j.status === 'completed' && before === 1 && after === 1) ok('I4.addItemsRetrySkip', `retry add_items: getTicketItemCount>0 → skip; ítems estable (${before}→${after})`);
    else no('I4.addItemsRetrySkip', `status=${j.status} items ${before}→${after} err=${j.last_error}`);
  }

  // ── I5: retry de create_payment → skip (due===0) ──
  {
    const o = await L.createOnlineOrder(c); track(o.id);
    const { jobId } = await L.enqueueInjection(c, cfg, o.id, { withPayment: true, amountCents: due });
    await L.waitJob(c, jobId);
    const row = await L.orderRow(c, o.id); const tid = row?.pos_id || row?.omnivore_pos_id;
    const t1 = tid ? await L.ticketTotals(ax, tid) : null;
    await resetStepAndRequeue(c, jobId, 'create_payment');
    const j = await L.waitJob(c, jobId);
    const t2 = tid ? await L.ticketTotals(ax, tid) : null;
    if (j.status === 'completed' && t1?.pays === t2?.pays && t2?.paid === t1?.paid) ok('I5.createPaymentRetrySkip', `retry create_payment: due===0 → skip; pagos estable (pays ${t1?.pays}→${t2?.pays}, paid ${t1?.paid}→${t2?.paid})`);
    else no('I5.createPaymentRetrySkip', `status=${j.status} pays ${t1?.pays}→${t2?.pays} paid ${t1?.paid}→${t2?.paid} err=${j.last_error}`);
  }

  // ── I10: re-enqueue con job en dead-letter → no crea 2º job (no duplica) ──
  {
    const o = await L.createOnlineOrder(c); track(o.id);
    const { jobId } = await L.enqueueInjection(c, cfg, o.id, { withPayment: true, amountCents: due });
    await L.waitJob(c, jobId);
    const row = await L.orderRow(c, o.id); const tid = row?.pos_id || row?.omnivore_pos_id;
    const items1 = tid ? await L.ticketItems(ax, tid) : -1;
    // simular dead-letter
    await c.query(`update integration_jobs set status='dead_letter' where id=$1`, [jobId]);
    // re-enqueue misma llave (trigger re-dispara)
    const { jobId: jobId2 } = await L.enqueueInjection(c, cfg, o.id, { withPayment: true, amountCents: due });
    await L.sleep(2500);
    const jobCount = Number((await c.query(`select count(*) n from integration_jobs where reference_id=$1 and site_id=$2 and job_type='order_injection'`, [String(o.id), L.SITE])).rows[0].n);
    const items2 = tid ? await L.ticketItems(ax, tid) : -1;
    if (String(jobId2) === String(jobId) && jobCount === 1 && items2 === items1) ok('I10.deadLetterReEnqueue', `re-enqueue con dead-letter → MISMO job (sin 2º), sin ticket nuevo (${items1}→${items2}); recuperación = retry manual`);
    else no('I10.deadLetterReEnqueue', `job=${jobId} job2=${jobId2} jobCount=${jobCount} items ${items1}→${items2}`);
  }

  // ── CLEANUP ──
  console.log('\n--- cleanup ---');
  for (const id of orders) { try { await L.cleanupOrder(c, ax, cfg, id); } catch (e) { console.log('cl err', id, e.message); } }
  await c.end();
  console.log(`\n===== INYECCIÓN FUNCIONAL: ${pass.length} pass / ${fail.length} fail =====`);
  if (findings.length) console.log('HALLAZGOS:\n' + findings.map((f) => '  - ' + f).join('\n'));
  if (fail.length) process.exit(1);
})().catch((e) => { console.error('FATAL', e.message, e.stack); process.exit(1); });
