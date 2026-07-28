/**
 * F7 · Operación real de restaurante + F1 restantes.
 * Cada caso es independiente: si uno falla, los demás siguen.
 */
const L = require('./lib.cjs');
const { omni, clover, db, CERT_SITE: S, saveEvidence, TOK, sleep } = L;
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);
const out = [];
let mesas = [];
const M = (i) => mesas[i];

async function syncMcm(tid, { cycles = 4 } = {}) {
  const r = await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', () => db.orderByOmnivore(S, tid), { maxCycles: cycles });
  return r.got;
}
async function pushClover(mcmId) {
  await db.syncUntil(S, 'clover', 'push_orders', async () => { const o = await db.order(S, mcmId); return o?.clover_ticket_id ? o : null; }, { maxCycles: 4 });
  await sleep(5000);
  return db.order(S, mcmId);
}
async function caso(tag, titulo, fn) {
  console.log(`\n── ${tag} · ${titulo}`);
  try { const r = await fn(); out.push({ tag, titulo, ...r }); }
  catch (e) { console.log(`   ✗ excepción: ${String(e).slice(0, 120)}`); out.push({ tag, titulo, error: String(e).slice(0, 200) }); }
}

(async () => {
  const tb = await omni.call('GET', '/tables/?limit=1000');
  mesas = els(tb.body?._embedded?.tables).filter((x) => x.available).map((x) => String(x.id));
  console.log(`═══ F7 · operación real · ${mesas.length} mesas libres ═══`);

  // ── 7.12 · Comp 100 %: el cheque queda en $0. ¿Se empuja una orden de $0 a Clover?
  await caso('7.12', 'comp / cortesía 100 % (total = 0)', async () => {
    const t = await omni.openTicket({ name: `CERT-${TOK}-712`, table: M(2), guestCount: 2 });
    const tid = t.body.id;
    await omni.addItems(tid, [{ menu_item: '300025', quantity: 1, auto_send: true }]);
    const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
    const d = await omni.call('POST', `/tickets/${tid}/discounts/`, [{ discount: 'c83', value: 10000 }]);
    const w2 = await omni.waitTotals(tid, w.totals.total, { timeoutMs: 20000 });
    console.log(`   POS: total ${w.totals.total} → ${w2.totals.total} (descuentos ${w2.totals.discounts})  descuento HTTP ${d.status}`);
    const m = await syncMcm(tid); if (!m) return { no_verificado: 'no llegó a MCM' };
    await sleep(3000);
    const m2 = await pushClover(m.id);
    const cl = m2.clover_ticket_id ? (await clover.order(m2.clover_ticket_id)).body : null;
    console.log(`   MCM ${m.id}: total=${m2.total}  → Clover ${m2.clover_ticket_id || 'no se empujó'}${cl ? ` total=${cl.total}` : ''}`);
    const sobre = cl ? Number(cl.total || 0) - Number(w2.totals.total) : null;
    console.log(`   ${cl && sobre > 0 ? `✗ Clover cobra ${sobre}¢ por una cortesía del 100 %` : cl ? '~ revisar' : '✓ no se empujó'}`);
    return { ticket: tid, pos_total: w2.totals.total, mcm_total: m2.total, clover_total: cl?.total ?? null, sobrecobro: sobre };
  });

  // ── 7.6 · Transferencia de mesa desde el POS (M6 al revés: aquí la mueve Aloha)
  await caso('7.6', 'transferencia de mesa en el terminal', async () => {
    const t = await omni.openTicket({ name: `CERT-${TOK}-76`, table: M(4), guestCount: 2 });
    const tid = t.body.id;
    await omni.addItems(tid, [{ menu_item: '300015', quantity: 1, auto_send: true }]);
    await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
    const m = await syncMcm(tid); if (!m) return { no_verificado: 'no llegó a MCM' };
    const antes = await db.order(S, m.id);
    const mv = await omni.call('POST', `/tickets/${tid}/`, { table: M(5) });
    console.log(`   mover mesa ${M(4)} → ${M(5)}: HTTP ${mv.status} ${mv.ok ? '' : JSON.stringify(mv.body?.errors)}`);
    await sleep(3000);
    await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', async () => {
      const o = await db.order(S, m.id); return String(o?.experience_reference || '') === String(M(5)) ? o : null;
    }, { maxCycles: 3 });
    const desp = await db.order(S, m.id);
    const tk = await omni.ticket(tid);
    console.log(`   POS mesa ahora: ${tk.body?._embedded?.table?.id ?? '—'}`);
    console.log(`   MCM experience_reference: '${antes.experience_reference}' → '${desp.experience_reference}'  table_id ${antes.table_id} → ${desp.table_id}`);
    const ok = String(desp.experience_reference) === String(tk.body?._embedded?.table?.id ?? '');
    console.log(`   ${ok ? '✓ MCM siguió la mesa' : '✗ MCM quedó con la mesa vieja'}`);
    return { ticket: tid, mcm_id: m.id, pos_mesa: tk.body?._embedded?.table?.id, mcm_antes: antes.experience_reference, mcm_despues: desp.experience_reference, ok };
  });

  // ── 1.12 · Multi-check: 3 cheques abiertos en la MISMA mesa
  await caso('1.12', 'multi-check en una mesa (3 cheques)', async () => {
    const mesa = M(7); const tids = [];
    for (let i = 0; i < 3; i++) {
      const t = await omni.openTicket({ name: `CERT-${TOK}-MC${i}`, table: mesa, guestCount: 2 });
      if (!t.ok) { console.log(`   cheque ${i + 1}: ✗ ${JSON.stringify(t.body?.errors)}`); continue; }
      tids.push(t.body.id);
      await omni.addItems(t.body.id, [{ menu_item: '300015', quantity: 1, auto_send: true }]);
    }
    console.log(`   abiertos en Aloha sobre la mesa ${mesa}: ${tids.length}`);
    const ords = [];
    for (const tid of tids) { const m = await syncMcm(tid, { cycles: 3 }); if (m) ords.push(await db.order(S, m.id)); }
    ords.forEach((o) => console.log(`     MCM ${o.id}: check_number=${o.check_number} table_id=${o.table_id} pos_id=${o.pos_id}`));
    const nums = ords.map((o) => Number(o.check_number));
    const unicos = new Set(nums).size === nums.length;
    console.log(`   check_number únicos: ${unicos ? '✓' : '✗ colisión'} (${nums.join(', ')})  ·  ${ords.length}/${tids.length} llegaron a MCM`);
    return { mesa, tickets: tids, check_numbers: nums, unicos, en_mcm: ords.length };
  });

  // ── 1.23 · Fire selectivo: solo algunos ítems pasan a cocina
  await caso('1.23', 'fire selectivo (solo 1 de 3 ítems)', async () => {
    const t = await omni.openTicket({ name: `CERT-${TOK}-123`, table: M(9), guestCount: 2 });
    const tid = t.body.id;
    await omni.addItems(tid, [
      { menu_item: '300015', quantity: 1, auto_send: false },
      { menu_item: '300025', quantity: 1, auto_send: false },
      { menu_item: '300155', quantity: 1, auto_send: false }]);
    await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
    const tk0 = await omni.call('GET', `/tickets/${tid}/?fields=items(id,sent,name)`);
    const items = els(tk0.body?._embedded?.items);
    console.log(`   ítems: ${items.length}  enviados antes del fire: ${items.filter((i) => i.sent).length}`);
    const fr = await omni.call('POST', `/tickets/${tid}/fire/`, { items: [{ ticket_item: items[0]?.id }] });
    console.log(`   fire de 1 ítem → HTTP ${fr.status} ${fr.ok ? '' : JSON.stringify(fr.body?.errors)}`);
    await sleep(2500);
    const tk1 = await omni.call('GET', `/tickets/${tid}/?fields=items(id,sent,name)`);
    const enviados = els(tk1.body?._embedded?.items).filter((i) => i.sent);
    console.log(`   enviados después del fire: ${enviados.length} (${enviados.map((i) => i.name).join(', ')})`);
    const m = await syncMcm(tid); if (!m) return { no_verificado: 'no llegó a MCM' };
    await sleep(2500);
    const o = await db.order(S, m.id);
    const sent = (o.line_items || []).filter((li) => li.status === 'sent');
    console.log(`   MCM ${o.id}: status='${o.status}'  líneas 'sent': ${sent.length}/${(o.line_items || []).length}`);
    const ok = sent.length === enviados.length;
    console.log(`   ${ok ? '✓ MCM espeja el fire selectivo' : '✗ MCM no coincide con el POS'}`);
    return { ticket: tid, mcm_id: o.id, enviados_pos: enviados.length, sent_mcm: sent.length, status: o.status, ok };
  });

  // ── 1.25 · Void del ticket COMPLETO
  await caso('1.25', 'void de ticket completo', async () => {
    const t = await omni.openTicket({ name: `CERT-${TOK}-125`, table: M(11), guestCount: 1 });
    const tid = t.body.id;
    await omni.addItems(tid, [{ menu_item: '300025', quantity: 1, auto_send: true }]);
    const w = await omni.waitTotals(tid, 0, { timeoutMs: 30000 });
    const m = await syncMcm(tid); if (!m) return { no_verificado: 'no llegó a MCM' };
    const m1 = await pushClover(m.id);
    console.log(`   antes del void: POS=${w.totals.total} MCM=${m1.total} Clover=${m1.clover_ticket_id || '—'}`);
    const v = await omni.call('POST', `/tickets/${tid}/`, { void: true });
    console.log(`   void del ticket → HTTP ${v.status} ${v.ok ? '' : JSON.stringify(v.body?.errors)}`);
    await sleep(3000);
    const tk = await omni.ticket(tid);
    console.log(`   POS tras el void: open=${tk.body?.open} totals=${JSON.stringify(tk.body?.totals)}`);
    await db.syncUntil(S, 'omnivore', 'fetch_recent_orders', async () => {
      const o = await db.order(S, m.id); return ['cancelled', 'voided'].includes(String(o?.status)) ? o : null;
    }, { maxCycles: 3 });
    const m2 = await db.order(S, m.id);
    const cl = m1.clover_ticket_id ? (await clover.order(m1.clover_ticket_id)).body : null;
    console.log(`   MCM ${m.id}: status='${m2.status}' total=${m2.total}`);
    console.log(`   Clover ${m1.clover_ticket_id || '—'}: total=${cl?.total ?? '—'} state=${cl?.state ?? '—'} paymentState=${cl?.paymentState ?? '—'}`);
    const mcmAnulada = ['cancelled', 'voided'].includes(String(m2.status));
    console.log(`   ${mcmAnulada ? '✓ MCM refleja la anulación' : '✗ MCM sigue viva'} · ${cl && cl.paymentState === 'OPEN' ? '✗ la orden Clover quedó ABIERTA y cobrable' : ''}`);
    return { ticket: tid, mcm_id: m.id, mcm_status: m2.status, clover: cl ? { total: cl.total, state: cl.state, paymentState: cl.paymentState } : null, mcmAnulada };
  });

  // ── 7.10 · Doble tap del mesero: dos tickets para la misma mesa a la vez
  await caso('7.10', 'doble tap: 2 tickets simultáneos en la misma mesa', async () => {
    const mesa = M(13);
    const [a, b] = await Promise.all([
      omni.openTicket({ name: `CERT-${TOK}-DTA`, table: mesa, guestCount: 2 }),
      omni.openTicket({ name: `CERT-${TOK}-DTB`, table: mesa, guestCount: 2 }),
    ]);
    console.log(`   ticket A: ${a.ok ? a.body.id : JSON.stringify(a.body?.errors)}`);
    console.log(`   ticket B: ${b.ok ? b.body.id : JSON.stringify(b.body?.errors)}`);
    const vivos = [a, b].filter((x) => x.ok).map((x) => x.body.id);
    for (const tid of vivos) await omni.addItems(tid, [{ menu_item: '300155', quantity: 1, auto_send: true }]);
    const ords = [];
    for (const tid of vivos) { const m = await syncMcm(tid, { cycles: 3 }); if (m) ords.push(await db.order(S, m.id)); }
    ords.forEach((o) => console.log(`     MCM ${o.id}: check_number=${o.check_number} pos_id=${o.pos_id}`));
    console.log(`   ${vivos.length === 2 ? 'Aloha aceptó los dos' : 'Aloha bloqueó el segundo'} · ${ords.length} en MCM, ${new Set(ords.map((o) => o.check_number)).size} check_number distintos`);
    return { mesa, tickets: vivos, en_mcm: ords.length, check_numbers: ords.map((o) => o.check_number) };
  });

  console.log(`\n══ F7 · resumen ══`);
  out.forEach((r) => console.log(`  ${r.tag} ${r.titulo}: ${r.error ? 'ERROR ' + r.error : r.no_verificado ? 'NO VERIFICADO — ' + r.no_verificado : 'corrido'}`));
  saveEvidence(`f7-${TOK}`, { casos: out });
  const nb = await L.assertNeighborsIntact('F7');
  console.log(`  vecinos intactos: ${nb.ok ? 'sí' : 'NO'}`);
  await db.close();
})();
