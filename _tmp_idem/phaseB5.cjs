require('dotenv').config({ path: __dirname + '/../.env' });
const { Client } = require('pg');
const axios = require('axios');
const SITE=55126712, TOK=Date.now().toString(36).slice(-5).toUpperCase();
const SR=process.env.SUPABASE_SERVICE_ROLE_KEY, SUPA=process.env.SUPABASE_URL;
const M=20; // llaves
const edge=async(slug,body,key)=>{try{const r=await axios.post(`${SUPA}/functions/v1/${slug}`,{site_id:SITE,...body,idempotency_key:key},{headers:{Authorization:`Bearer ${SR}`,apikey:SR,'Content-Type':'application/json'},validateStatus:()=>true,timeout:40000});return{status:r.status,id:r.data?.order?.id,err:r.data?.error};}catch(e){return{status:0,err:e.code||e.message};}};
(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
  const cfg=(await c.query(`select config from site_integrations where site_id=$1 and provider='omnivore' and active=true limit 1`,[SITE])).rows[0].config;
  const ax=axios.create({baseURL:`https://api.omnivore.io/1.0/locations/${cfg.omnivoreId}`,headers:{'Api-Key':cfg.apiKey,'Content-Type':'application/json'},timeout:30000,validateStatus:()=>true});
  const tables=(await c.query(`select id from floor_elements where site_id=$1 and type='table' and status='available' order by random() limit $2`,[SITE,M+2])).rows.map(r=>r.id);
  const key=(i)=>`${TOK}-dt-${i}`;
  // 40 calls: cada llave 2 veces, TODO en un solo batch paralelo
  const calls=[]; for(let i=0;i<M;i++){calls.push(i);calls.push(i);}
  console.log(`B5: double-tap concurrente — ${M} llaves × 2 = ${calls.length} calls en paralelo simultáneo...`);
  const t0=Date.now();
  const res=await Promise.all(calls.map(i=>edge('open-table-order',{table_id:tables[i],guests:1,employee:{id:'975',first_name:'DT'}},key(i))));
  const wall=Date.now()-t0;
  const s200=res.filter(r=>r.status===200).length, s409=res.filter(r=>r.status===409&&r.err==='in_flight').length, other=res.filter(r=>r.status!==200&&!(r.status===409&&r.err==='in_flight'));
  const n=Number((await c.query(`select count(*) n from orders where site_id=$1 and additional_properties->>'idempotency_key' like $2`,[SITE,`${TOK}-dt-%`])).rows[0].n);
  const dups=(await c.query(`select additional_properties->>'idempotency_key' k, count(*) n from orders where site_id=$1 and additional_properties->>'idempotency_key' like $2 group by 1 having count(*)>1`,[SITE,`${TOK}-dt-%`])).rows;
  console.log(`B5: ${s200}×200, ${s409}×409(in_flight), ${other.length} otros; wall ${(wall/1000).toFixed(1)}s`);
  console.log(`B5: órdenes creadas=${n} (debe ser ${M}), llaves con duplicado=${dups.length} (debe ser 0)`);
  if(other.length) console.log('  otros:',JSON.stringify(other.slice(0,5)));
  const verdict=(n===M && dups.length===0)?'✅ PASS':'❌ FAIL';
  console.log(`${verdict} — double-tap concurrente a volumen: exactamente ${M} órdenes, 0 duplicados (claim serializó ${s409} carreras con 409)`);
  // cleanup
  const all=(await c.query(`select id, pos_id, omnivore_pos_id from orders where site_id=$1 and additional_properties->>'idempotency_key' like $2`,[SITE,`${TOK}-dt-%`])).rows;
  for(const o of all){const tid=o.omnivore_pos_id||o.pos_id; if(tid){try{const t=await ax.get(`/tickets/${tid}`,{params:{fields:'totals(due),open'}});const due=Number(t.data?.totals?.due??0);if(t.data?.open!==false&&due>0)await ax.post(`/tickets/${tid}/payments`,{type:'3rd_party',tender_type:cfg.defaultTenderId,amount:due,tip:0,comment:'B5cl'},{headers:{'Idempotency-Id':`B5cl-${tid}`}});}catch{}}}
  await c.query(`update orders set closed_at=now(), status='check-closed' where site_id=$1 and additional_properties->>'idempotency_key' like $2 and closed_at is null`,[SITE,`${TOK}-dt-%`]);
  await c.query(`update floor_elements set status='available' where id=any($1) and site_id=$2`,[tables,SITE]);
  await c.query(`delete from idempotency_keys where key like $1`,[`${TOK}-%`]);
  console.log(`cleanup: ${all.length} órdenes cerradas`);
  await c.end();
})().catch(e=>{console.error('FATAL',e.response?.status,e.message,JSON.stringify(e.response?.data));process.exit(1);});
