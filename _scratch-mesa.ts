import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();
const sb=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!);
const U=process.env.SUPABASE_URL!, K=process.env.SUPABASE_SERVICE_ROLE_KEY!;
const H={'Content-Type':'application/json',Authorization:`Bearer ${K}`,apikey:K};
const CK='f3ad633c-fac0-f4dc-9b36-50336d8a3d73';
const CM='https://api.clover.com/v3/merchants/YQ8J5VA6RFRP1';
(async()=>{
  const {data:mesas}=await sb.from('floor_elements').select('id,table_number').eq('site_id','70030000').eq('table_number','103').limit(1);
  const mesa:any=(mesas as any)[0];
  const r=await fetch(`${U}/functions/v1/open-table-order`,{method:'POST',headers:H,
    body:JSON.stringify({site_id:'70030000',table_id:mesa.id,guests:2,idempotency_key:'zz-verif-mesa-'+Date.now(),
      employee:{id:'0000',first_name:'Admin',last_name:'',email:''}})});
  const b=await r.json();
  const id=b?.order?.id ?? b?.id;
  console.log(`[1] open-table-order (mesa ${mesa.table_number}) -> HTTP ${r.status} orden=${id}`);
  if(!id){ console.log(JSON.stringify(b).slice(0,300)); return; }

  const {data:o0}=await sb.from('orders').select('clover_ticket_id,additional_properties,experience,experience_reference').eq('id',id).eq('site_id','70030000').single();
  console.log(`    al abrir: ticket=${(o0 as any).clover_ticket_id??'-'} gestionada=${(o0 as any).additional_properties?.clover_managed} exp=${(o0 as any).experience}/${(o0 as any).experience_reference}`);

  const {data:prods}=await sb.from('products').select('id').eq('site_id','70030000').eq('price',10).limit(1);
  await fetch(`${U}/functions/v1/add-products-to-order`,{method:'POST',headers:H,
    body:JSON.stringify({order_id:id,site_id:'70030000',line_items:[{product_id:String((prods as any)[0].id),quantity:1}]})});
  const {data:o1}=await sb.from('orders').select('line_items,clover_ticket_id').eq('id',id).eq('site_id','70030000').single();
  const ids=((o1 as any).line_items??[]).map((l:any)=>l.id);

  const r3=await fetch(`${U}/functions/v1/send-to-kitchen`,{method:'POST',headers:H,
    body:JSON.stringify({order_id:id,site_id:'70030000',line_item_ids:ids})});
  console.log(`[2] fire -> HTTP ${r3.status}`);
  await new Promise(x=>setTimeout(x,2500));
  const {data:o2}=await sb.from('orders').select('clover_ticket_id,line_items,experience,experience_reference').eq('id',id).eq('site_id','70030000').single();
  const d:any=o2;
  const rr=await fetch(`${CM}/orders/${d.clover_ticket_id}?expand=lineItems`,{headers:{Authorization:`Bearer ${CK}`}});
  const t=await rr.json(); const n=(t?.lineItems?.elements??[]).length;
  console.log(`[3] CLOVER ${t.id} titulo="${t.title}" lineas=${n} ${n===1?'PASA (1 linea, no duplica)':'FALLA'}`);
  console.log(`    MCM exp=${d.experience}/${d.experience_reference}`);
  console.log(`\nORDEN=${id} TICKET=${d.clover_ticket_id}`);
})();
