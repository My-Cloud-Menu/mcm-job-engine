import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();
const sb=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!);
const U=process.env.SUPABASE_URL!, K=process.env.SUPABASE_SERVICE_ROLE_KEY!;
const H={'Content-Type':'application/json',Authorization:`Bearer ${K}`,apikey:K};
const CK='f3ad633c-fac0-f4dc-9b36-50336d8a3d73';
const CM='https://api.clover.com/v3/merchants/YQ8J5VA6RFRP1';
const ID=10041;
(async()=>{
  // Mismo estado con el que nace un Pickup del POS (new-order): create-order-v2 solo lo pone
  // cuando hay usuario autenticado, y yo llamo con service_role.
  await sb.from('orders').update({status:'new-order'}).eq('id',ID).eq('site_id','70030000');

  const {data:prods}=await sb.from('products').select('id,name,price').eq('site_id','70030000').in('price',[10,6]).limit(2);
  const r2=await fetch(`${U}/functions/v1/add-products-to-order`,{method:'POST',headers:H,
    body:JSON.stringify({order_id:ID,site_id:'70030000',
      line_items:(prods as any[]).map(p=>({product_id:String(p.id),quantity:1}))})});
  console.log(`[1] add-products -> HTTP ${r2.status}`);
  if(r2.status>=400){ console.log(JSON.stringify(await r2.json()).slice(0,300)); return; }

  const {data:o1}=await sb.from('orders').select('line_items,clover_ticket_id,additional_properties,total').eq('id',ID).eq('site_id','70030000').single();
  const ids=((o1 as any).line_items??[]).map((l:any)=>l.id);
  console.log(`    ANTES del fire: lineas=${ids.length} ticket=${(o1 as any).clover_ticket_id??'NINGUNO'} gestionada=${(o1 as any).additional_properties?.clover_managed??false}`);

  const r3=await fetch(`${U}/functions/v1/send-to-kitchen`,{method:'POST',headers:H,
    body:JSON.stringify({order_id:ID,site_id:'70030000',line_item_ids:ids})});
  console.log(`[2] send-to-kitchen -> HTTP ${r3.status}`);
  await new Promise(x=>setTimeout(x,2500));

  const {data:o2}=await sb.from('orders').select('line_items,clover_ticket_id,additional_properties,total').eq('id',ID).eq('site_id','70030000').single();
  const d:any=o2;
  console.log(`\n[3] MCM: ticket=${d.clover_ticket_id??'NINGUNO'} gestionada=${d.additional_properties?.clover_managed??false} total=${d.total}`);
  for(const l of d.line_items){const c=l.additional_properties?.clover??{};
    console.log(`    ${l.name} status=${l.status??'-'} origin=${c.origin??'-'} ancla=${JSON.stringify(c.line_item_ids??null)}`);}
  if(!d.clover_ticket_id){ console.log('\nFALLA: sigue sin ticket'); return; }

  const rr=await fetch(`${CM}/orders/${d.clover_ticket_id}?expand=lineItems,lineItems.taxRates`,{headers:{Authorization:`Bearer ${CK}`}});
  const t=await rr.json(); const els=t?.lineItems?.elements??[];
  console.log(`\n[4] CLOVER ${t.id} titulo="${t.title}" lineas=${els.length}`);
  for(const e of els){const tr=e.taxRates?.elements??[];
    console.log(`    ${e.name} ${e.price}c tasas=${tr.length}: ${tr.map((x:any)=>x.name+'='+x.taxAmount).join(' ')}`);}

  const r6=await fetch(`${U}/functions/v1/send-to-kitchen`,{method:'POST',headers:H,
    body:JSON.stringify({order_id:ID,site_id:'70030000',line_item_ids:ids})});
  await new Promise(x=>setTimeout(x,2500));
  const n2=(((await (await fetch(`${CM}/orders/${d.clover_ticket_id}?expand=lineItems`,{headers:{Authorization:`Bearer ${CK}`}})).json())?.lineItems?.elements)??[]).length;
  console.log(`\n[5] 2do fire HTTP ${r6.status} -> CLOVER ${n2} lineas ${n2===els.length?'PASA (no duplica)':'FALLA'}`);
  console.log(`\nTICKET=${d.clover_ticket_id}`);
})();
