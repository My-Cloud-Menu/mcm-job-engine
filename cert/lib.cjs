/**
 * Harness de certificación Omnivore × Clover.
 *
 * REGLA ESTRUCTURAL: toda lectura/escritura a la DB pasa por `db.*`, que EXIGE
 * site_id como primer parámetro. No hay forma de consultar sin scope de tenant:
 * si falta, tira. Es deliberado — `orders.id` y `payments.id` NO son únicos
 * globalmente (PK compuesta por site), así que una query sin site_id devuelve
 * filas de otros negocios.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/bc0a1714-bd08-4f4e-8bb1-1eb2d5e198f5/scratchpad';
const env = Object.fromEntries(
  fs.readFileSync(path.join(SCRATCH, 'cert.env'), 'utf8').trim().split('\n').map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  })
);
const jobEnv = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const CERT_SITE = Number(env.CERT_SITE);
const NEIGHBORS = [25612612, 25512412, 99990001, 51021421, 48372619];

// ─────────────────────────── DB con site_id obligatorio ───────────────────────────
let pg = null;
async function pgc() {
  if (!pg) { pg = new Client({ connectionString: jobEnv.DATABASE_URL }); await pg.connect(); }
  return pg;
}
function requireSite(siteId, who) {
  if (siteId === undefined || siteId === null || Number.isNaN(Number(siteId))) {
    throw new Error(`[multi-tenant] ${who}: site_id es obligatorio y no se pasó`);
  }
  return Number(siteId);
}
const db = {
  /** Query libre pero con site_id obligatorio como $1. El SQL DEBE usar $1 para site_id. */
  async q(siteId, sql, params = []) {
    const s = requireSite(siteId, 'db.q');
    if (!/\$1/.test(sql)) throw new Error('[multi-tenant] db.q: el SQL debe referenciar $1 (site_id)');
    const c = await pgc();
    return (await c.query(sql, [s, ...params])).rows;
  },
  async order(siteId, orderId) {
    const s = requireSite(siteId, 'db.order');
    const r = await (await pgc()).query(
      `select id, site_id, status, payment_status, total, subtotal, total_tax, paid,
              discount_total, fee_total, pos_id, omnivore_pos_id, clover_pos_id, clover_ticket_id,
              clover_payment_id, clover_line_items_hash, check_number, table_id, channel, experience,
              line_items, tax_lines, fee_lines, additional_properties, issues, pos_injection_error,
              date_created, date_updated, closed_at
         from orders where site_id=$1 and id=$2`, [s, orderId]);
    return r.rows[0] || null;
  },
  async orderByOmnivore(siteId, omnivorePosId) {
    const s = requireSite(siteId, 'db.orderByOmnivore');
    const r = await (await pgc()).query(
      `select id from orders where site_id=$1 and omnivore_pos_id=$2`, [s, omnivorePosId]);
    return r.rows[0] ? this.order(s, r.rows[0].id) : null;
  },
  async payments(siteId, orderId) {
    const s = requireSite(siteId, 'db.payments');
    return (await (await pgc()).query(
      `select id, site_id, status, method, source, total, tip, total_refunded, pos_id, reference,
              orders_ids, additional_properties, pos_request_payload, date_created
         from payments where site_id=$1 and $2 = any(orders_ids) order by id`, [s, String(orderId)])).rows;
  },
  async jobs(siteId, sinceIso) {
    const s = requireSite(siteId, 'db.jobs');
    return (await (await pgc()).query(
      `select id, job_type, integration, status, idempotency_key, last_error, context, payload,
              created_at, completed_at
         from integration_jobs where site_id=$1 and created_at >= $2 order by created_at`, [s, sinceIso])).rows;
  },
  async schedules(siteId) {
    const s = requireSite(siteId, 'db.schedules');
    return (await (await pgc()).query(
      `select integration, sync_type, status, interval_seconds, consecutive_failures, last_error, last_run_at
         from sync_schedules where site_id=$1 order by integration, sync_type`, [s])).rows;
  },
  /** Espera a que un job termine. Scoped por site. */
  async waitJob(siteId, jobId, timeoutMs = 120000) {
    const s = requireSite(siteId, 'db.waitJob');
    const t0 = Date.now();
    for (;;) {
      const r = await (await pgc()).query(
        `select id, status, last_error, context, completed_at from integration_jobs where site_id=$1 and id=$2`, [s, jobId]);
      const j = r.rows[0];
      if (j && ['completed', 'dead_letter', 'cancelled'].includes(j.status)) return j;
      if (Date.now() - t0 > timeoutMs) return j ? { ...j, timedOut: true } : { timedOut: true };
      await sleep(1500);
    }
  },
  /** Dispara un sync one-shot y espera. */
  async syncNow(siteId, integration, syncType, timeoutMs = 180000) {
    const s = requireSite(siteId, 'db.syncNow');
    const c = await pgc();
    const r = await c.query(`select trigger_sync_now($1,$2,$3) as job_id`, [s, integration, syncType]);
    return this.waitJob(s, r.rows[0].job_id, timeoutMs);
  },
  /**
   * Corre ciclos de sync hasta que `check()` devuelva algo truthy.
   *
   * Necesario porque `trigger_sync_now` NO encola si ya hay un job activo del
   * mismo (site, integration, sync_type): devuelve el job EN CURSO, que pudo
   * arrancar antes de que existiera lo que estamos esperando. Un solo ciclo no
   * garantiza nada. (Gate de la migración 017.)
   */
  async syncUntil(siteId, integration, syncType, check, { maxCycles = 4, timeoutMs = 180000 } = {}) {
    const s = requireSite(siteId, 'db.syncUntil');
    let last = null;
    for (let i = 0; i < maxCycles; i++) {
      const got = await check();
      if (got) return { got, cycles: i, job: last };
      last = await this.syncNow(s, integration, syncType, timeoutMs);
      await sleep(1200);
    }
    return { got: await check(), cycles: maxCycles, job: last };
  },
  async raw() { return pgc(); },
  async close() { if (pg) { await pg.end(); pg = null; } },
};

// ─────────────────────────── Omnivore = el mesero ───────────────────────────
const OB = `https://api.omnivore.io/1.0/locations/${env.OMNI_LOC}`;
const OH = { 'Api-Key': env.OMNI_KEY, 'Content-Type': 'application/json', Accept: 'application/json' };
async function ocall(method, p, body, idem) {
  const h = { ...OH }; if (idem) h['Idempotency-Id'] = idem;
  const r = await fetch(OB + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b, ok: r.status >= 200 && r.status < 300 && !b?.errors };
}
const omni = {
  cfg: { employee: '975', orderType: '1', revenueCenter: '20', tenderDefault: '979',
         tenderCash: '1', tenderVisa: '975', tenderMC: '976', tenderAmex: '978', voidType: '2' },
  call: ocall,
  async openTicket({ name, table, guestCount = 2, autoSend = false, employee, orderType, revenueCenter }) {
    return ocall('POST', '/tickets/', {
      employee: employee ?? this.cfg.employee,
      order_type: orderType ?? this.cfg.orderType,
      revenue_center: revenueCenter ?? this.cfg.revenueCenter,
      ...(table ? { table: String(table) } : {}),
      guest_count: guestCount, name, auto_send: autoSend,
    });
  },
  async addItems(ticketId, items) { return ocall('POST', `/tickets/${ticketId}/items/`, { items }); },
  async fire(ticketId, ticketItemIds) {
    return ocall('POST', `/tickets/${ticketId}/fire/`,
      ticketItemIds?.length ? { items: ticketItemIds.map((i) => ({ ticket_item: String(i) })) } : {});
  },
  async voidItem(ticketId, itemId, voidType) {
    return ocall('DELETE', `/tickets/${ticketId}/items/${itemId}/`, { void_type: voidType ?? this.cfg.voidType });
  },
  async voidTicket(ticketId) { return ocall('POST', `/tickets/${ticketId}/`, { void: true }); },
  async pay(ticketId, { amount, tip = 0, tenderType, autoClose = true, comment }) {
    return ocall('POST', `/tickets/${ticketId}/payments/`, {
      type: '3rd_party', amount, tip, tender_type: tenderType ?? this.cfg.tenderDefault,
      auto_close: autoClose, ...(comment ? { comment } : {}),
    });
  },
  async ticketDiscount(ticketId, discountId, value) {
    return ocall('POST', `/tickets/${ticketId}/discounts/`, [{ discount: String(discountId), value }]);
  },
  /**
   * Espera a que Aloha refleje una mutación en `totals`.
   *
   * Medido en vivo: el POST responde en ~900 ms pero `totals` tarda ~1.5 s en
   * reflejar el cambio. Leer antes devuelve el estado viejo — no es un fallo,
   * es latencia del POS, y hay que respetarla o las aserciones son basura.
   */
  async waitTotals(ticketId, prevTotal, { timeoutMs = 15000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const t = await this.ticket(ticketId);
      const cur = t.body?.totals?.total;
      if (cur !== undefined && Number(cur) !== Number(prevTotal)) return { totals: t.body.totals, ticket: t.body, waitedMs: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) return { totals: t.body?.totals, ticket: t.body, waitedMs: Date.now() - t0, timedOut: true };
      await sleep(300);
    }
  },
  async ticket(ticketId) {
    const FIELDS = 'id,name,open,opened_at,closed_at,ticket_number,' +
      'totals(due,paid,items,discounts,service_charges,tax,total,sub_total,tips),' +
      'employee(id,first_name,last_name),table(id,name),' +
      'items(id,sent,sent_at,name,comment,price,quantity,menu_item(id))';
    return ocall('GET', `/tickets/${ticketId}/?fields=${encodeURIComponent(FIELDS)}`);
  },
  async openTickets() { return ocall('GET', '/tickets/?where=eq(open,true)&limit=100'); },
};

// ─────────────────────────── Clover = el terminal Flex ───────────────────────────
const CB = `https://apisandbox.dev.clover.com/v3/merchants/${env.CLOVER_MID}`;
const CH = { Authorization: `Bearer ${env.CLOVER_TOKEN}`, 'User-Agent': 'MCM-Certification/1.0',
             'Content-Type': 'application/json', Accept: 'application/json' };
async function ccall(method, p, body, extraHeaders) {
  const r = await fetch(CB + p, { method, headers: { ...CH, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b, ok: r.status >= 200 && r.status < 300 };
}
const clover = {
  cfg: { orderType: 'E409NQ4X4RQ0T', tenderMCM: '4QPPVE0NFNBN4', tenderCash: 'QV0654SVQF9RW',
         tenderCredit: 'BX9GRVH6Q6HXW', tenderDebit: 'P111W186KJV0J', employee: '1Q9BN5ZC7CB7Y',
         taxEstatal: '348P6Q73G0JX8', taxReduced: 'AEYTXX25NKZKE', taxMunicipal: 'BHNNEH2NBTGHA' },
  call: ccall,
  /** OJO: `lineItems.taxRates` hay que pedirlo explícitamente o el tax no viene. */
  async order(orderId) {
    return ccall('GET', `/orders/${orderId}?expand=lineItems,lineItems.taxRates,lineItems.modifications,payments,refunds,discounts`);
  },
  async lineItems(orderId) { return ccall('GET', `/orders/${orderId}/line_items?expand=taxRates,modifications,discounts`); },
  async orderByExtRef(extRef) {
    return ccall('GET', `/orders?filter=${encodeURIComponent(`externalReferenceId=${extRef}`)}&expand=lineItems,payments&limit=5`);
  },
  /** Simula el cobro del Flex sobre una orden existente. */
  async pay(orderId, { amount, tip = 0, tender, externalPaymentId, idempotencyKey }) {
    return ccall('POST', `/orders/${orderId}/payments`,
      { amount, tipAmount: tip, tender: { id: tender ?? this.cfg.tenderMCM },
        ...(externalPaymentId ? { externalPaymentId } : {}) },
      idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined);
  },
  async payment(paymentId) { return ccall('GET', `/payments/${paymentId}?expand=order,tender,cardTransaction,refunds`); },
  async payments(sinceMs) {
    return ccall('GET', `/payments?filter=${encodeURIComponent(`modifiedTime>=${sinceMs}`)}&expand=order,refunds,tender&limit=100`);
  },
};

// ─────────────────────────── utilidades ───────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (v) => Math.round(Number(v ?? 0) * 100);
const TOK = process.env.CERT_TOK || Date.now().toString(36).slice(-4).toUpperCase();

/**
 * Clover envuelve las colecciones anidadas en `{elements:[...]}` — incluido
 * `lineItem.taxRates`. Verificado en vivo: sin `expand=lineItems.taxRates` el
 * campo ni siquiera viene, y con expand llega como objeto, no como array.
 */
const els = (x) => (Array.isArray(x) ? x : x?.elements || []);

/** Compara los tres sistemas al centavo. Devuelve el detalle, no solo un booleano. */
function reconcile({ omnivoreTotals, mcmOrder, cloverOrder }) {
  const o = omnivoreTotals ? Number(omnivoreTotals.total) : null;           // ya en centavos
  const m = mcmOrder ? cents(mcmOrder.total) : null;
  const cLines = els(cloverOrder?.lineItems).reduce(
    (a, li) => a + (li.price || 0) + els(li.taxRates).reduce((x, t) => x + (t.taxAmount || 0), 0), 0);
  const cTotal = cloverOrder ? cloverOrder.total : null;
  return {
    omnivore_total_cents: o, mcm_total_cents: m, clover_order_total: cTotal, clover_sum_lines: cLines,
    mcm_vs_omnivore: o !== null && m !== null ? m - o : null,
    clover_vs_mcm: cTotal !== null && m !== null ? cTotal - m : null,
    clover_lines_vs_total: cTotal !== null ? cLines - cTotal : null,
    cuadra: o !== null && m !== null && cTotal !== null && m === o && cTotal === m && cLines === cTotal,
  };
}

/** Aserción de no-contaminación: los vecinos no cambiaron. */
async function assertNeighborsIntact(label) {
  const c = await pgc();
  const rows = (await c.query(`
    select b.site_id, b.orders as orders_antes, b.payments as payments_antes,
           (select count(*) from orders o where o.site_id=b.site_id) as orders_ahora,
           (select count(*) from payments p where p.site_id=b.site_id) as payments_ahora
      from _cert_baseline_20260727 b order by b.site_id`)).rows;
  const bad = rows.filter((r) => Number(r.orders_antes) !== Number(r.orders_ahora)
                              || Number(r.payments_antes) !== Number(r.payments_ahora));
  return { label, ok: bad.length === 0, detalle: rows, violaciones: bad };
}

// ─────────────────────────── evidencia ───────────────────────────
const EVDIR = path.join(__dirname, 'evidence');
function redact(o) {
  const S = /apikey|api_key|token|authorization|service_role|password|secret/i;
  const walk = (v) => Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, S.test(k) ? '«redacted»' : walk(x)]))
      : v;
  return walk(o);
}
function saveEvidence(name, data) {
  fs.mkdirSync(EVDIR, { recursive: true });
  const f = path.join(EVDIR, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(redact(data), null, 2));
  return f;
}

/** Recolecta las 3 fuentes que exige §A.8 del plan. */
async function collect(siteId, { mcmOrderId, omnivoreTicketId, cloverOrderId, sinceIso }) {
  const s = requireSite(siteId, 'collect');
  const out = { site_id: s, at: new Date().toISOString() };
  if (mcmOrderId) { out.db_order = await db.order(s, mcmOrderId); out.db_payments = await db.payments(s, mcmOrderId); }
  if (sinceIso) out.db_jobs = await db.jobs(s, sinceIso);
  if (omnivoreTicketId) out.api_omnivore = (await omni.ticket(omnivoreTicketId)).body;
  if (cloverOrderId) out.api_clover = (await clover.order(cloverOrderId)).body;
  return out;
}

module.exports = { env, CERT_SITE, NEIGHBORS, db, omni, clover, sleep, cents, TOK,
                   reconcile, assertNeighborsIntact, saveEvidence, collect, redact, EVDIR };
