/**
 * EXHAUSTIVE Omnivore Idempotency-Id test harness — site "Carlos Business" (55126712)
 * POS: aloha (location cx9oRBRi "Kleshik DEMO").
 *
 * For each mutating op (create ticket / add items / apply payment / void item) we:
 *   (A) issue the SAME request twice with the SAME `Idempotency-Id` → if the POS
 *       honors it, NO duplicate (same id / unchanged count / unchanged paid).
 *   (B) CONTROL: issue with a DIFFERENT id → MUST duplicate, proving the probe is valid.
 * Void is additionally tested for NATURAL idempotency (2nd DELETE → 404 = ok).
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');

const SITE = '55126712';
const TOK = Date.now().toString(36).slice(-5).toUpperCase(); // 5 chars
const RUN = `IDEM-${TOK}`;
// Aloha caps ticket name at 15 chars → keep names short: "IT"+TOK(5)+tag.
const nm = (tag) => `IT${TOK}${tag}`.slice(0, 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const createdTickets = new Set();

function record(name, verdict, detail) {
  results.push({ test: name, verdict, detail });
  const tag = verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '❌' : 'ℹ️';
  console.log(`${tag} [${name}] ${verdict} — ${detail}`);
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(
    `select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE]);
  await c.end();
  const cfg = rows[0].config;
  const ax = axios.create({
    baseURL: `https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`,
    headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json' },
    timeout: 30000, validateStatus: () => true,
  });

  const EMP = cfg.defaultEmployeeId, OT = cfg.defaultOrderTypeId, RC = cfg.defaultRevenueCenterId;
  const TENDER = cfg.defaultTenderId; // 979 SPC OTHER
  const MENU = '300015'; // Chips & Salsa $6.00

  const errOf = (r) => JSON.stringify(r.data?.errors ?? r.data ?? null);
  const itemCount = async (tid) => {
    const r = await ax.get(`/tickets/${tid}`, { params: { fields: 'items(id)' } });
    return (r.data?._embedded?.items ?? []).length;
  };
  const totals = async (tid) => {
    const r = await ax.get(`/tickets/${tid}`, { params: { fields: 'totals(due,paid,total),open,payments(id)' } });
    return {
      due: r.data?.totals?.due, paid: r.data?.totals?.paid, total: r.data?.totals?.total,
      open: r.data?.open, payCount: (r.data?._embedded?.payments ?? []).length,
    };
  };
  const makeTicket = async (name, idemId) => {
    const body = { employee: EMP, order_type: OT, revenue_center: RC, name, auto_send: false };
    const h = idemId ? { 'Idempotency-Id': idemId } : {};
    const r = await ax.post('/tickets', body, { headers: h });
    if (r.data?.id) createdTickets.add(r.data.id);
    return r;
  };

  console.log(`\n=== RUN ${RUN} | site ${SITE} | location ${cfg.omnivoreId} (aloha) ===\n`);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1 — CREATE TICKET idempotency via header (same Idempotency-Id twice)
  // ───────────────────────────────────────────────────────────────────────────
  {
    const idem = `${RUN}-T1`;
    const name = nm('C');
    const r1 = await makeTicket(name, idem);
    await sleep(800);
    const r2 = await makeTicket(name, idem);
    const id1 = r1.data?.id, id2 = r2.data?.id;
    if (id1 && id2 && id1 === id2) {
      record('T1.create.sameHeader', 'PASS', `header honored — same ticket id (${id1}) on retry`);
    } else if (id1 && id2 && id1 !== id2) {
      record('T1.create.sameHeader', 'FAIL', `DUPLICATE — id1=${id1} id2=${id2} (header NOT honored by aloha)`);
    } else {
      record('T1.create.sameHeader', 'INFO', `r1=${r1.status}/${id1||errOf(r1)} r2=${r2.status}/${id2||errOf(r2)}`);
    }
  }

  // TEST 1b — CONTROL: different Idempotency-Id → must create 2 tickets
  {
    const name = nm('CC');
    const r1 = await makeTicket(name, `${RUN}-T1b-A`);
    await sleep(600);
    const r2 = await makeTicket(name, `${RUN}-T1b-B`);
    const id1 = r1.data?.id, id2 = r2.data?.id;
    if (id1 && id2 && id1 !== id2) record('T1b.create.diffHeader(control)', 'PASS', `2 distinct tickets as expected (${id1}, ${id2}) — probe is valid`);
    else record('T1b.create.diffHeader(control)', 'INFO', `id1=${id1} id2=${id2} r1=${r1.status} r2=${r2.status}`);
  }

  // TEST 1c — ADOPT-BY-NAME (the code's deterministic guard, header-independent)
  {
    const name = nm('AD');
    const r1 = await makeTicket(name, `${RUN}-T1c`);
    await sleep(1200);
    const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const look = await ax.get('/tickets', { params: { where: `and(eq(open,true),eq(name,'${esc}'))`, fields: 'id', limit: 1 } });
    const found = look.data?._embedded?.tickets?.[0]?.id;
    if (found && found === r1.data?.id) record('T1c.adoptByName', 'PASS', `lookup found the open ticket by name (${found}) → code would ADOPT, never re-create`);
    else record('T1c.adoptByName', 'FAIL', `lookup did not return the created ticket (created=${r1.data?.id} found=${found||errOf(look)})`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2 — ADD ITEMS idempotency via header (same Idempotency-Id twice)
  // ───────────────────────────────────────────────────────────────────────────
  let t2id;
  {
    const tk = await makeTicket(nm('ADD'), `${RUN}-T2-open`);
    t2id = tk.data?.id;
    if (!t2id) { record('T2.add.sameHeader', 'INFO', `could not open ticket: ${tk.status} ${errOf(tk)}`); }
    else {
      const items = [{ menu_item: MENU, quantity: 1, item_order_mode: OT, auto_send: true }];
      const idem = `${RUN}-T2`;
      const a1 = await ax.post(`/tickets/${t2id}/items`, { items }, { headers: { 'Idempotency-Id': idem } });
      await sleep(1500);
      const c1 = await itemCount(t2id);
      const a2 = await ax.post(`/tickets/${t2id}/items`, { items }, { headers: { 'Idempotency-Id': idem } });
      await sleep(1500);
      const c2 = await itemCount(t2id);
      if (c2 === c1) record('T2.add.sameHeader', 'PASS', `header honored — item count stable at ${c1} after retry (a1=${a1.status} a2=${a2.status})`);
      else record('T2.add.sameHeader', 'FAIL', `DUPLICATE items — count ${c1}→${c2} (header NOT honored). a2=${a2.status} ${a2.status>=300?errOf(a2):''}`);
    }
  }

  // TEST 2b — CONTROL: different Idempotency-Id on same ticket → count must grow
  if (t2id) {
    const items = [{ menu_item: MENU, quantity: 1, item_order_mode: OT, auto_send: true }];
    const before = await itemCount(t2id);
    const a = await ax.post(`/tickets/${t2id}/items`, { items }, { headers: { 'Idempotency-Id': `${RUN}-T2b-${Date.now()}` } });
    await sleep(1500);
    const after = await itemCount(t2id);
    if (after > before) record('T2b.add.diffHeader(control)', 'PASS', `count grew ${before}→${after} as expected — duplication IS possible without dedup (probe valid)`);
    else record('T2b.add.diffHeader(control)', 'INFO', `count ${before}→${after} a=${a.status} ${errOf(a)}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3 — APPLY PAYMENT idempotency via header (PARTIAL, ticket stays open)
  // ───────────────────────────────────────────────────────────────────────────
  {
    const tk = await makeTicket(nm('PAY'), `${RUN}-T3-open`);
    const tid = tk.data?.id;
    if (!tid) { record('T3.pay.sameHeader', 'INFO', `no ticket: ${errOf(tk)}`); }
    else {
      const add = await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: MENU, quantity: 2, item_order_mode: OT, auto_send: true }] }, { headers: { 'Idempotency-Id': `${RUN}-T3-add` } });
      await sleep(1800);
      const t0 = await totals(tid);
      const due0 = Number(t0.due ?? 0);
      const partial = Math.max(1, Math.floor(due0 / 4)); // pay 1/4 so ticket stays open for a 2nd attempt
      const payBody = { type: '3rd_party', tender_type: TENDER, amount: partial, tip: 0, comment: `${RUN} idem test` };
      const idem = `${RUN}-T3-pay`;
      const p1 = await ax.post(`/tickets/${tid}/payments`, payBody, { headers: { 'Idempotency-Id': idem } });
      await sleep(1800);
      const t1 = await totals(tid);
      const p2 = await ax.post(`/tickets/${tid}/payments`, payBody, { headers: { 'Idempotency-Id': idem } });
      await sleep(1800);
      const t2 = await totals(tid);
      const detail = `due0=${due0} partial=${partial} | after1: paid=${t1.paid} payCount=${t1.payCount} (p1=${p1.status}) | after2: paid=${t2.paid} payCount=${t2.payCount} (p2=${p2.status} ${p2.status>=300?errOf(p2):''})`;
      if (Number(t2.paid) === Number(t1.paid) && t2.payCount === t1.payCount) {
        record('T3.pay.sameHeader', 'PASS', `header honored — paid/payCount unchanged on retry. ${detail}`);
      } else if (Number(t2.paid) > Number(t1.paid)) {
        record('T3.pay.sameHeader', 'FAIL', `DOUBLE PAYMENT — paid increased on retry (header NOT honored). ${detail}`);
      } else {
        record('T3.pay.sameHeader', 'INFO', detail);
      }

      // TEST 3b — CONTROL: different header, same partial → paid must increase (if balance remains)
      const t1b = await totals(tid);
      if (Number(t1b.due) > 0) {
        const amt = Math.max(1, Math.min(partial, Number(t1b.due)));
        const pc = await ax.post(`/tickets/${tid}/payments`, { ...payBody, amount: amt }, { headers: { 'Idempotency-Id': `${RUN}-T3b-${Date.now()}` } });
        await sleep(1800);
        const t2b = await totals(tid);
        if (Number(t2b.paid) > Number(t1b.paid)) record('T3b.pay.diffHeader(control)', 'PASS', `paid grew ${t1b.paid}→${t2b.paid} as expected (probe valid)`);
        else record('T3b.pay.diffHeader(control)', 'INFO', `paid ${t1b.paid}→${t2b.paid} pc=${pc.status} ${errOf(pc)}`);
      } else {
        record('T3b.pay.diffHeader(control)', 'INFO', `no remaining balance to test control (due=${t1b.due})`);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4 — VOID ITEM natural idempotency (DELETE same id twice → 2nd = 404 = ok)
  // ───────────────────────────────────────────────────────────────────────────
  {
    const tk = await makeTicket(nm('VD'), `${RUN}-T4-open`);
    const tid = tk.data?.id;
    if (!tid) { record('T4.void.natural', 'INFO', `no ticket: ${errOf(tk)}`); }
    else {
      // auto_send:false so the item is NOT fired → deletable on aloha
      const add = await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: MENU, quantity: 1, item_order_mode: OT, auto_send: false }] }, { headers: { 'Idempotency-Id': `${RUN}-T4-add` } });
      await sleep(1500);
      const r = await ax.get(`/tickets/${tid}`, { params: { fields: 'items(id)' } });
      const itemId = r.data?._embedded?.items?.[0]?.id;
      if (!itemId) { record('T4.void.natural', 'INFO', `no item to void (add=${add.status} ${errOf(add)})`); }
      else {
        const d1 = await ax.delete(`/tickets/${tid}/items/${itemId}`);
        await sleep(1200);
        const d2 = await ax.delete(`/tickets/${tid}/items/${itemId}`);
        const ok1 = (d1.status >= 200 && d1.status < 300);
        const ok2treated = (d2.status === 404) || (d2.status >= 200 && d2.status < 300);
        if (ok1 && ok2treated) record('T4.void.natural', 'PASS', `1st DELETE=${d1.status}, 2nd DELETE=${d2.status} (code treats 2xx/404 as idempotent success) — no double-void possible`);
        else record('T4.void.natural', 'FAIL', `1st=${d1.status} 2nd=${d2.status} ${errOf(d2)}`);

        // TEST 4b — void of a FIRED (sent) item — expected non-retryable rejection on aloha
        const addF = await ax.post(`/tickets/${tid}/items`, { items: [{ menu_item: MENU, quantity: 1, item_order_mode: OT, auto_send: true }] }, { headers: { 'Idempotency-Id': `${RUN}-T4b-add` } });
        await sleep(1800);
        const r2 = await ax.get(`/tickets/${tid}`, { params: { fields: 'items(id)' } });
        const firedId = r2.data?._embedded?.items?.[0]?.id;
        if (firedId) {
          const df = await ax.delete(`/tickets/${tid}/items/${firedId}`);
          record('T4b.void.firedItem', 'INFO', `DELETE fired item → ${df.status} ${df.status>=300?errOf(df):'(deleted)'} — non-2xx/404 ⇒ code returns retryable:false, MCM voids locally + "anular en terminal"`);
        } else {
          record('T4b.void.firedItem', 'INFO', `no fired item present (addF=${addF.status})`);
        }
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CLEANUP — close created test tickets by paying the balance full (auto_close)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- cleanup: closing test tickets ---');
  for (const tid of createdTickets) {
    try {
      const t = await totals(tid);
      if (t.open === false) continue;
      const due = Number(t.due ?? 0);
      if (due > 0) {
        await ax.post(`/tickets/${tid}/payments`, { type: '3rd_party', tender_type: TENDER, amount: due, tip: 0, full: true, comment: `${RUN} cleanup` }, { headers: { 'Idempotency-Id': `${RUN}-cleanup-${tid}` } });
      } else {
        // zero-balance open ticket: try void-all if supported
        await ax.post(`/tickets/${tid}/void`, {}).catch(()=>{});
      }
      await sleep(400);
      const t2 = await totals(tid);
      console.log(`  ticket ${tid}: open ${t.open}→${t2.open} (due ${due})`);
    } catch (e) { console.log(`  ticket ${tid}: cleanup error ${e.message}`); }
  }

  // ── SUMMARY ──
  console.log(`\n================ SUMMARY (run ${RUN}) ================`);
  const pass = results.filter(r => r.verdict === 'PASS').length;
  const fail = results.filter(r => r.verdict === 'FAIL').length;
  const info = results.filter(r => r.verdict === 'INFO').length;
  console.table(results.map(r => ({ test: r.test, verdict: r.verdict })));
  console.log(`PASS=${pass} FAIL=${fail} INFO=${info}`);
  console.log(`Tickets created this run: ${[...createdTickets].join(', ')}`);
})().catch((e) => { console.error('FATAL', e.response?.status, e.message, JSON.stringify(e.response?.data)); process.exit(1); });
