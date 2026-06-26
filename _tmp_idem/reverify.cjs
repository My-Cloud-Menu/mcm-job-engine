/**
 * RE-VERIFY idempotency vs Omnivore's documented promise.
 * Doc: "If the initial request actually succeeded, the API won't repeat the
 * operation and will instead return the response that should have been returned
 * for the initial request." → HONORED = same resource id / no repeat.
 * Site Carlos Business 55126712, POS aloha, location cx9oRBRi.
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');
const SITE='55126712', TOK=Date.now().toString(36).slice(-5).toUpperCase();
const nm=(t)=>`IT${TOK}${t}`.slice(0,15);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const created=new Set();
(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
  const {rows}=await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`,[SITE]);await c.end();
  const cfg=rows[0].config;
  const ax=axios.create({baseURL:`https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`,headers:{'Api-Key':cfg.apiKey,'Content-Type':'application/json'},timeout:30000,validateStatus:()=>true});
  const EMP=cfg.defaultEmployeeId,OT=cfg.defaultOrderTypeId,RC=cfg.defaultRevenueCenterId,TENDER=cfg.defaultTenderId,MENU='300015';
  const errOf=(r)=>JSON.stringify(r.data?.errors??r.data??null);
  const itemsOf=async(t)=>{const r=await ax.get(`/tickets/${t}`,{params:{fields:'items(id,menu_item,quantity)'}});return (r.data?._embedded?.items??[]).map(i=>({id:String(i.id),mi:String(i._embedded?.menu_item?.id??i.menu_item??''),q:i.quantity}));};
  const tot=async(t)=>{const r=await ax.get(`/tickets/${t}`,{params:{fields:'totals(due,paid),open,payments(id)'}});return{due:Number(r.data?.totals?.due??0),paid:Number(r.data?.totals?.paid??0),open:r.data?.open,pays:(r.data?._embedded?.payments??[]).map(p=>String(p.id))};};
  const mk=async(tag,idem)=>{const r=await ax.post('/tickets',{employee:EMP,order_type:OT,revenue_center:RC,name:nm(tag),auto_send:false},{headers:idem?{'Idempotency-Id':idem}:{}});if(r.data?.id)created.add(r.data.id);return r;};

  console.log(`\n############ RE-VERIFY idempotency vs Omnivore doc — TOK=${TOK}, loc ${cfg.omnivoreId} (aloha) ############`);
  console.log(`Doc promise: HONORED ⇒ retry returns the ORIGINAL resource (same id), no repeat.\n`);

  // ---- CREATE ----
  {
    const idem=`${TOK}-CR`;
    const r1=await mk('CR',idem); await sleep(900);
    const r2=await mk('CR',idem);
    console.log(`[CREATE]   idem=${idem}`);
    console.log(`           1st → ${r1.status} id=${r1.data?.id}`);
    console.log(`           2nd → ${r2.status} ${r2.data?.id?('id='+r2.data.id):errOf(r2)}`);
    const honored = r1.data?.id && r2.data?.id===r1.data.id;
    console.log(`           VERDICT: ${honored?'HONORED (same id)':'❌ NOT honored — 2nd request was re-processed (different response), per doc this means dedup did NOT happen'}\n`);
  }

  // ---- ADD ITEMS (capture ids to prove duplication) ----
  {
    const tk=await mk('AD',`${TOK}-ADo`); const tid=tk.data?.id;
    const idem=`${TOK}-AD`;
    const a1=await ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:1,item_order_mode:OT,auto_send:true}]},{headers:{'Idempotency-Id':idem}});
    await sleep(1600); const i1=await itemsOf(tid);
    const a2=await ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:1,item_order_mode:OT,auto_send:true}]},{headers:{'Idempotency-Id':idem}});
    await sleep(1600); const i2=await itemsOf(tid);
    console.log(`[ADD]      ticket=${tid} idem=${idem}`);
    console.log(`           1st POST → ${a1.status}; items now: [${i1.map(x=>x.id).join(', ')}] (count ${i1.length})`);
    console.log(`           2nd POST → ${a2.status}; items now: [${i2.map(x=>x.id).join(', ')}] (count ${i2.length})`);
    const dup = i2.length>i1.length;
    console.log(`           VERDICT: ${dup?`❌ NOT honored — DUPLICATE item created (count ${i1.length}→${i2.length}); the 2nd id ${i2.filter(x=>!i1.some(y=>y.id===x.id)).map(x=>x.id).join(',')} is a fresh row`:'HONORED (count stable)'}\n`);
  }

  // ---- PAYMENT (amount=due, no full) ----
  {
    const tk=await mk('PY',`${TOK}-PYo`); const tid=tk.data?.id;
    await ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:1,item_order_mode:OT,auto_send:true}]},{headers:{'Idempotency-Id':`${TOK}-PYa`}});
    await sleep(1700); const t0=await tot(tid);
    const idem=`${TOK}-PY`;
    const p1=await ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:TENDER,amount:t0.due,tip:0,comment:TOK},{headers:{'Idempotency-Id':idem}});
    await sleep(1700); const t1=await tot(tid);
    const p2=await ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:TENDER,amount:t0.due,tip:0,comment:TOK},{headers:{'Idempotency-Id':idem}});
    await sleep(1700); const t2=await tot(tid);
    console.log(`[PAYMENT]  ticket=${tid} idem=${idem} due0=${t0.due}`);
    console.log(`           1st → ${p1.status} ${p1.data?.id?('payId='+p1.data.id):''}; paid=${t1.paid} pays=[${t1.pays.join(',')}] open=${t1.open}`);
    console.log(`           2nd → ${p2.status} ${p2.status>=300?errOf(p2):('payId='+p2.data?.id)}; paid=${t2.paid} pays=[${t2.pays.join(',')}] open=${t2.open}`);
    const honored = p2.data?.id && p2.data.id===p1.data?.id;
    const doubled = t2.paid>t1.paid || t2.pays.length>t1.pays.length;
    console.log(`           VERDICT: ${honored?'HONORED (same payId)':doubled?'❌ DOUBLE PAYMENT':'❌ header NOT honored — but no double-charge: blocked by ticket_closed/due===0 (state guard, NOT the header)'}\n`);
  }

  // ---- VOID (double DELETE) ----
  {
    const tk=await mk('VD',`${TOK}-VDo`); const tid=tk.data?.id;
    await ax.post(`/tickets/${tid}/items`,{items:[{menu_item:MENU,quantity:1,item_order_mode:OT,auto_send:false}]},{headers:{'Idempotency-Id':`${TOK}-VDa`}});
    await sleep(1500); const it=await itemsOf(tid); const iid=it[0]?.id;
    const d1=await ax.delete(`/tickets/${tid}/items/${iid}`); await sleep(1200);
    const d2=await ax.delete(`/tickets/${tid}/items/${iid}`);
    const slug=Array.isArray(d2.data?.errors)&&d2.data.errors[0]?.error?d2.data.errors[0].error:`http_${d2.status}`;
    console.log(`[VOID]     ticket=${tid} item=${iid}`);
    console.log(`           1st DELETE → ${d1.status}`);
    console.log(`           2nd DELETE → ${d2.status}/${slug}`);
    console.log(`           VERDICT: idempotent by NATURE of DELETE on a unique id (not the header). Code branch (2xx||404) does NOT cover ${d2.status} ⇒ plan adds reference_not_found handling.\n`);
  }

  // ---- cleanup ----
  console.log('--- cleanup ---');
  for(const tid of created){try{const t=await tot(tid);if(t.open===false)continue;if(t.due>0){await ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:TENDER,amount:t.due,tip:0,comment:'cleanup'},{headers:{'Idempotency-Id':`cl-${tid}`}});}}catch(e){}}
  console.log('done. tickets:', [...created].join(', '));
})().catch(e=>{console.error('FATAL',e.response?.status,e.message,JSON.stringify(e.response?.data));process.exit(1);});
