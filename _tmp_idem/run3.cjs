/**
 * run3 — FINAL clean idempotency probes. Aloha requires revenue_center; payments
 * are amount-based (NO `full`, mirrors production getPaymentStructure/buildOmnivorePaymentBody).
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');
const SITE='55126712', TOK=Date.now().toString(36).slice(-5).toUpperCase();
const nm=(t)=>`IT${TOK}${t}`.slice(0,15);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const created=new Set(); const out=[];
const rec=(n,v,d)=>{out.push({test:n,verdict:v});console.log(`${v==='PASS'?'✅':v==='FAIL'?'❌':'ℹ️'} [${n}] ${v} — ${d}`);};

(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
  const {rows}=await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`,[SITE]);await c.end();
  const cfg=rows[0].config;
  const ax=axios.create({baseURL:`https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`,headers:{'Api-Key':cfg.apiKey,'Content-Type':'application/json'},timeout:30000,validateStatus:()=>true});
  const EMP=cfg.defaultEmployeeId,OT=cfg.defaultOrderTypeId,RC=cfg.defaultRevenueCenterId,TENDER=cfg.defaultTenderId,MENU='300015';
  const errOf=(r)=>JSON.stringify(r.data?.errors??r.data??null);
  const tot=async(t)=>{const r=await ax.get(`/tickets/${t}`,{params:{fields:'totals(due,paid),open,payments(id)'}});return{due:Number(r.data?.totals?.due??0),paid:Number(r.data?.totals?.paid??0),open:r.data?.open,pc:(r.data?._embedded?.payments??[]).length};};
  const cnt=async(t)=>{const r=await ax.get(`/tickets/${t}`,{params:{fields:'items(id)'}});return (r.data?._embedded?.items??[]).length;};
  const mk=async(tag,idem)=>{const r=await ax.post('/tickets',{employee:EMP,order_type:OT,revenue_center:RC,name:nm(tag),auto_send:false},{headers:idem?{'Idempotency-Id':idem}:{}});if(r.data?.id)created.add(r.data.id);return r;};
  const addItems=async(tid,qty,idem)=>ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:qty,item_order_mode:OT,auto_send:true}]},{headers:{'Idempotency-Id':idem}});
  const pay=async(tid,amount,idem)=>ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:TENDER,amount,tip:0,comment:`${TOK}`},{headers:{'Idempotency-Id':idem}});

  console.log(`\n=== run3 TOK=${TOK} site ${SITE} loc ${cfg.omnivoreId} (aloha) | amount-based payments, RC=${RC} ===\n`);

  // ── CREATE header dedup (1st create succeeds; 2nd same body+header) ───────────
  {
    const idem=`${TOK}-C`;
    const r1=await mk('C',idem); await sleep(900);
    const r2=await mk('C',idem);
    const id1=r1.data?.id,id2=r2.data?.id;
    if(id1&&id2&&id1===id2) rec('CREATE.header','PASS',`same id ${id1} on retry → header HONORED`);
    else if(id1&&id2&&id1!==id2) rec('CREATE.header','FAIL',`DUPLICATE tickets ${id1}≠${id2} → header NOT honored`);
    else rec('CREATE.header','FAIL',`retry response DIFFERS from original (header not replaying) — r1=${r1.status}/${id1||''} r2=${r2.status}/${id2||errOf(r2)}`);
  }

  // ── ADD ITEMS header dedup (the decisive, unconfounded probe) ────────────────
  {
    const tk=await mk('A',`${TOK}-Ao`); const tid=tk.data?.id;
    if(!tid){rec('ADD.header','INFO',`no ticket ${errOf(tk)}`);}
    else{
      const idem=`${TOK}-A`;
      const a1=await addItems(tid,1,idem); await sleep(1600); const c1=await cnt(tid);
      const a2=await addItems(tid,1,idem); await sleep(1600); const c2=await cnt(tid);
      if(c2===c1&&c1>0) rec('ADD.header','PASS',`count stable at ${c1} on retry (a1=${a1.status} a2=${a2.status}) → header HONORED`);
      else if(c2>c1) rec('ADD.header','FAIL',`DUPLICATE items ${c1}→${c2} (a2=${a2.status}) → Idempotency-Id NOT honored on aloha`);
      else rec('ADD.header','INFO',`c1=${c1} c2=${c2} a1=${a1.status} a2=${a2.status}`);
      // CONTROL: different header must grow count
      const before=await cnt(tid); await addItems(tid,1,`${TOK}-Actrl-${Date.now()}`); await sleep(1600); const after=await cnt(tid);
      rec('ADD.control.diffHeader', after>before?'PASS':'INFO', `count ${before}→${after} with a different header (proves duplication is real)`);
    }
  }

  // ── PAYMENT header dedup (amount = exact due, NO full; mirrors production) ────
  {
    const tk=await mk('P',`${TOK}-Po`); const tid=tk.data?.id;
    if(!tid){rec('PAY.header','INFO',`no ticket ${errOf(tk)}`);}
    else{
      await addItems(tid,2,`${TOK}-Pa`); await sleep(1800);
      const t0=await tot(tid);
      const idem=`${TOK}-Ppay`;
      const p1=await pay(tid,t0.due,idem); await sleep(1800); const t1=await tot(tid);
      const p2=await pay(tid,t0.due,idem); await sleep(1800); const t2=await tot(tid);
      const d=`due0=${t0.due} | p1=${p1.status} after1{paid=${t1.paid},pc=${t1.pc},open=${t1.open}} | p2=${p2.status}${p2.status>=300?'('+errOf(p2)+')':''} after2{paid=${t2.paid},pc=${t2.pc},open=${t2.open}}`;
      if(t2.paid>t1.paid||t2.pc>t1.pc) rec('PAY.header','FAIL',`DOUBLE PAYMENT on retry — ${d}`);
      else if(p1.status<300&&t1.paid>0) rec('PAY.header','PASS',`paid once; retry blocked by natural guard (ticket closed/not_found), no double-charge — ${d}`);
      else rec('PAY.header','INFO',d);
    }
  }

  // ── VOID double-DELETE natural idempotency (404 vs 400 reference_not_found) ───
  {
    const tk=await mk('V',`${TOK}-Vo`); const tid=tk.data?.id;
    if(!tid){rec('VOID.doubleDelete','INFO',`no ticket ${errOf(tk)}`);}
    else{
      await ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:1,item_order_mode:OT,auto_send:false}]},{headers:{'Idempotency-Id':`${TOK}-Va`}});
      await sleep(1500);
      const r=await ax.get(`/tickets/${tid}`,{params:{fields:'items(id)'}});
      const iid=r.data?._embedded?.items?.[0]?.id;
      if(!iid){rec('VOID.doubleDelete','INFO',`no item created`);}
      else{
        const d1=await ax.delete(`/tickets/${tid}/items/${iid}`); await sleep(1200);
        const d2=await ax.delete(`/tickets/${tid}/items/${iid}`);
        const slug=Array.isArray(d2.data?.errors)&&d2.data.errors[0]?.error?d2.data.errors[0].error:`http_${d2.status}`;
        const idem=(d2.status>=200&&d2.status<300)||d2.status===404;
        rec('VOID.doubleDelete', 'INFO',
          `1st DELETE=${d1.status} (item gone) · 2nd DELETE=${d2.status}/${slug}. Code's idempotent branch=(2xx||404). On aloha 2nd=${d2.status} ⇒ ${idem?'covered':'NOT in idempotent branch → handler returns ok:false (mitigated by MCM-level already_voided guard)'}`);
      }
    }
  }

  // ── CLEANUP: pay exact due (no full) to close my tickets + stuck leftovers ────
  console.log('\n--- cleanup ---');
  const stuck=['20260613-1010008','20260613-1010009','20260613-1010010'];
  for(const tid of new Set([...created,...stuck])){
    try{
      const t=await tot(tid);
      if(t.open===false){console.log(`  ${tid}: closed`);continue;}
      if(t.due>0){const r=await pay(tid,t.due,`cl-${tid}-${TOK}`);await sleep(500);const t2=await tot(tid);console.log(`  ${tid}: due ${t.due} pay=${r.status} → open ${t.open}→${t2.open} paid=${t2.paid}`);}
      else{console.log(`  ${tid}: due 0 (open, no balance)`);}
    }catch(e){console.log(`  ${tid}: ${e.message}`);}
  }

  console.log(`\n===== run3 SUMMARY (TOK ${TOK}) =====`);
  console.table(out);
  console.log('created:',[...created].join(', '));
})().catch(e=>{console.error('FATAL',e.response?.status,e.message,JSON.stringify(e.response?.data));process.exit(1);});
