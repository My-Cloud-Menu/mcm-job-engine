/**
 * run2 — CLEAN idempotency probes (confounds removed) + robust cleanup.
 * Site Carlos Business (55126712), POS aloha, location cx9oRBRi.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');

const SITE = '55126712';
const TOK = Date.now().toString(36).slice(-5).toUpperCase();
const nm = (t) => `IT${TOK}${t}`.slice(0, 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const created = new Set();
const out = [];
const rec = (n, v, d) => { out.push({ test: n, verdict: v }); console.log(`${v==='PASS'?'✅':v==='FAIL'?'❌':'ℹ️'} [${n}] ${v} — ${d}`); };

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`, [SITE]);
  await c.end();
  const cfg = rows[0].config;
  const ax = axios.create({ baseURL:`https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`, headers:{'Api-Key':cfg.apiKey,'Content-Type':'application/json'}, timeout:30000, validateStatus:()=>true });
  const EMP=cfg.defaultEmployeeId, OT=cfg.defaultOrderTypeId, RC=cfg.defaultRevenueCenterId, TENDER=cfg.defaultTenderId, MENU='300015';
  const TOGO = '4'; // TO GO order type → no table requirement
  const errOf = (r)=>JSON.stringify(r.data?.errors??r.data??null);
  const tot = async (tid)=>{const r=await ax.get(`/tickets/${tid}`,{params:{fields:'totals(due,paid,total),open,payments(id)'}});return{due:r.data?.totals?.due,paid:r.data?.totals?.paid,open:r.data?.open,pc:(r.data?._embedded?.payments??[]).length};};
  const cnt = async (tid)=>{const r=await ax.get(`/tickets/${tid}`,{params:{fields:'items(id)'}});return (r.data?._embedded?.items??[]).length;};

  console.log(`\n=== run2 TOK=${TOK} site ${SITE} loc ${cfg.omnivoreId} (aloha) ===\n`);

  // ── C1: CREATE header dedup, NO table (order_type TO GO) ─────────────────────
  {
    const body = { employee:EMP, order_type:TOGO, name:nm('C1'), auto_send:false };
    const idem = `${TOK}-C1`;
    const r1 = await ax.post('/tickets', body, { headers:{'Idempotency-Id':idem} });
    if (r1.data?.id) created.add(r1.data.id);
    await sleep(900);
    const r2 = await ax.post('/tickets', body, { headers:{'Idempotency-Id':idem} });
    if (r2.data?.id) created.add(r2.data.id);
    const id1=r1.data?.id, id2=r2.data?.id;
    if (id1&&id2&&id1===id2) rec('C1.create.header','PASS',`same id ${id1} → header HONORED`);
    else if (id1&&id2&&id1!==id2) rec('C1.create.header','FAIL',`DUPLICATE tickets ${id1} vs ${id2} → Idempotency-Id NOT honored on aloha`);
    else rec('C1.create.header','INFO',`r1=${r1.status}/${id1||errOf(r1)} r2=${r2.status}/${id2||errOf(r2)}`);
  }

  // ── C2: ticket name search support (the code's adopt-by-name guard) ───────────
  {
    const r = await ax.get('/tickets',{params:{where:`and(eq(open,true),eq(name,'${nm('C1')}'))`,fields:'id',limit:1}});
    if (r.status>=400 || r.data?.errors) rec('C2.nameSearch','FAIL',`adopt-by-name guard BROKEN on aloha → ${errOf(r)}`);
    else rec('C2.nameSearch','PASS',`name search supported (found=${r.data?._embedded?.tickets?.[0]?.id})`);
  }

  // ── A1: ADD ITEMS header dedup (re-confirm) ──────────────────────────────────
  let aTid;
  {
    const tk = await ax.post('/tickets',{employee:EMP,order_type:TOGO,name:nm('A1'),auto_send:false},{headers:{'Idempotency-Id':`${TOK}-A1o`}});
    aTid = tk.data?.id; if (aTid) created.add(aTid);
    const items=[{menu_item:MENU,quantity:1,item_order_mode:TOGO,auto_send:true}];
    const idem=`${TOK}-A1`;
    await ax.post(`/tickets/${aTid}/items`,{items},{headers:{'Idempotency-Id':idem}});
    await sleep(1500); const c1=await cnt(aTid);
    await ax.post(`/tickets/${aTid}/items`,{items},{headers:{'Idempotency-Id':idem}});
    await sleep(1500); const c2=await cnt(aTid);
    if (c2===c1) rec('A1.add.header','PASS',`count stable ${c1} → header HONORED`);
    else rec('A1.add.header','FAIL',`DUPLICATE items ${c1}→${c2} → Idempotency-Id NOT honored on aloha`);
  }

  // ── A2: job-engine guard (getTicketItemCount>0 → skip) is FEASIBLE on aloha ───
  if (aTid) {
    const n = await cnt(aTid);
    rec('A2.countGuard.feasible', n>0?'PASS':'INFO', `GET items returns count=${n} → job-engine 'already_present' guard works on aloha`);
  }

  // ── P1: PAYMENT header dedup — FULL payment (realistic create-flow path) ──────
  {
    const tk = await ax.post('/tickets',{employee:EMP,order_type:TOGO,name:nm('P1'),auto_send:false},{headers:{'Idempotency-Id':`${TOK}-P1o`}});
    const tid=tk.data?.id; if (tid) created.add(tid);
    await ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:1,item_order_mode:TOGO,auto_send:true}]},{headers:{'Idempotency-Id':`${TOK}-P1a`}});
    await sleep(1800);
    const t0=await tot(tid); const due=Number(t0.due??0);
    const pay={type:'3rd_party',tender_type:TENDER,amount:due,tip:0,full:true,comment:`${TOK} P1`};
    const idem=`${TOK}-P1pay`;
    const p1=await ax.post(`/tickets/${tid}/payments`,pay,{headers:{'Idempotency-Id':idem}});
    await sleep(1800); const t1=await tot(tid);
    const p2=await ax.post(`/tickets/${tid}/payments`,pay,{headers:{'Idempotency-Id':idem}});
    await sleep(1800); const t2=await tot(tid);
    const d=`due=${due} | p1=${p1.status} after1{paid=${t1.paid},pc=${t1.pc},open=${t1.open}} | p2=${p2.status}${p2.status>=300?'('+errOf(p2)+')':''} after2{paid=${t2.paid},pc=${t2.pc},open=${t2.open}}`;
    if (Number(t2.paid)>Number(t1.paid)||t2.pc>t1.pc) rec('P1.pay.full.header','FAIL',`DOUBLE PAYMENT — ${d}`);
    else if (p2.status>=300) rec('P1.pay.full.header','PASS',`retry rejected by POS natural guard (ticket closed/excessive), no double-charge — ${d}`);
    else rec('P1.pay.full.header','PASS',`paid/pc unchanged — ${d}`);
  }

  // ── P2: PAYMENT header dedup — PARTIAL (isolates header on an OPEN ticket) ────
  {
    const tk = await ax.post('/tickets',{employee:EMP,order_type:TOGO,name:nm('P2'),auto_send:false},{headers:{'Idempotency-Id':`${TOK}-P2o`}});
    const tid=tk.data?.id; if (tid) created.add(tid);
    await ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:3,item_order_mode:TOGO,auto_send:true}]},{headers:{'Idempotency-Id':`${TOK}-P2a`}});
    await sleep(1800);
    const t0=await tot(tid); const due=Number(t0.due??0);
    // probe a partial that aloha accepts: try one item's worth (600) then half
    const probe = async (amt) => { const r=await ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:TENDER,amount:amt,tip:0,comment:`${TOK}P2probe`},{headers:{'Idempotency-Id':`${TOK}-P2probe-${amt}-${Date.now()}`}}); return r; };
    // Use a partial = due - 100 (just under full) to keep it open, with same header twice
    const partial = Math.max(1, due - 100);
    const idem=`${TOK}-P2pay`;
    const p1=await ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:TENDER,amount:partial,tip:0,comment:`${TOK}P2`},{headers:{'Idempotency-Id':idem}});
    await sleep(1800); const t1=await tot(tid);
    if (p1.status>=300) {
      rec('P2.pay.partial.header','INFO',`aloha rejected partial (${errOf(p1)}) → 3rd_party requires full; natural 'due===0' guard governs. due=${due} partial=${partial}`);
    } else {
      const p2=await ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:TENDER,amount:partial,tip:0,comment:`${TOK}P2`},{headers:{'Idempotency-Id':idem}});
      await sleep(1800); const t2=await tot(tid);
      const d=`due=${due} partial=${partial} | after1{paid=${t1.paid},pc=${t1.pc}} | p2=${p2.status} after2{paid=${t2.paid},pc=${t2.pc}}`;
      if (Number(t2.paid)>Number(t1.paid)||t2.pc>t1.pc) rec('P2.pay.partial.header','FAIL',`DOUBLE PARTIAL PAYMENT — ${d}`);
      else rec('P2.pay.partial.header','PASS',`partial not duplicated on retry — ${d}`);
    }
  }

  // ── V1: VOID double-DELETE natural idempotency (404 vs 400 nuance) ───────────
  {
    const tk = await ax.post('/tickets',{employee:EMP,order_type:TOGO,name:nm('V1'),auto_send:false},{headers:{'Idempotency-Id':`${TOK}-V1o`}});
    const tid=tk.data?.id; if (tid) created.add(tid);
    await ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:1,item_order_mode:TOGO,auto_send:false}]},{headers:{'Idempotency-Id':`${TOK}-V1a`}});
    await sleep(1500);
    const r=await ax.get(`/tickets/${tid}`,{params:{fields:'items(id)'}});
    const iid=r.data?._embedded?.items?.[0]?.id;
    if (!iid) rec('V1.void.doubleDelete','INFO',`no item to void`);
    else {
      const d1=await ax.delete(`/tickets/${tid}/items/${iid}`);
      await sleep(1200);
      const d2=await ax.delete(`/tickets/${tid}/items/${iid}`);
      const slug = Array.isArray(d2.data?.errors)&&d2.data.errors[0]?.error ? d2.data.errors[0].error : `http_${d2.status}`;
      const codeTreatsIdempotent = (d2.status>=200&&d2.status<300)||d2.status===404;
      rec('V1.void.doubleDelete', codeTreatsIdempotent?'PASS':'FAIL',
        `1st=${d1.status} 2nd=${d2.status}/${slug}. Code idempotent-success branch = (2xx||404). ${codeTreatsIdempotent?'covered':'NOT covered → code reports ok:false (non-retryable) on a 2nd void of an already-removed item'}`);
    }
  }

  // ── CLEANUP: close ALL my tickets (this run + previous run leftovers) ─────────
  console.log('\n--- cleanup ---');
  const prev = ['20260613-1010005','20260613-1010006','20260613-1010007','20260613-1010008','20260613-1010009','20260613-1010010'];
  const all = new Set([...created, ...prev]);
  for (const tid of all) {
    try {
      const t = await tot(tid);
      if (t.open === false) { console.log(`  ${tid}: already closed`); continue; }
      const due = Number(t.due ?? 0);
      let r;
      if (due > 0) r = await ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:TENDER,amount:due,tip:0,full:true,comment:'cleanup'},{headers:{'Idempotency-Id':`cl-${tid}`}});
      else r = await ax.post(`/tickets/${tid}/void`,{}).catch(()=>({status:'n/a'}));
      await sleep(500);
      const t2 = await tot(tid);
      console.log(`  ${tid}: open ${t.open}→${t2.open} due=${due} payStatus=${r?.status}${r?.status>=300?' '+errOf(r):''}`);
    } catch(e){ console.log(`  ${tid}: ${e.message}`); }
  }

  console.log(`\n===== run2 SUMMARY (TOK ${TOK}) =====`);
  console.table(out);
  console.log('tickets created this run:', [...created].join(', '));
})().catch(e=>{console.error('FATAL',e.response?.status,e.message,JSON.stringify(e.response?.data));process.exit(1);});
