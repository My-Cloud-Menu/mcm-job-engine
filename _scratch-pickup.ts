import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();
const sb=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!);
const U=process.env.SUPABASE_URL!, K=process.env.SUPABASE_SERVICE_ROLE_KEY!;
const H={'Content-Type':'application/json',Authorization:`Bearer ${K}`,apikey:K};
const CK='f3ad633c-fac0-f4dc-9b36-50336d8a3d73';
const CM='https://api.clover.com/v3/merchants/YQ8J5VA6RFRP1';
(async()=>{
  // 1 · Pickup igual que lo crea PickupModal (create-order-v2)
  const r=await fetch(`${U}/functions/v1/create-order-v2`,{method:'POST',headers:H,
    body:JSON.stringify({site_id:'70030000',channel:'pos',experience:'pu',
      customer:{first_name:'ZZ Verificacion Pickup',last_name:'',phone:''},
      employee:{id:'0000',first_name:'Admin',last_name:'',email:''}})});
  const b=await r.json();
  const id=b?.order?.id ?? b?.summary?.id ?? b?.id;
  console.log(`[1] create-order-v2 -> HTTP ${r.status}  orden=${id}`);
  if(!id){ console.log(JSON.stringify(b).slice(0,300)); return; }

  // 2 · anadir 2 productos, como haria el POS
  const {data:prods}=await sb.from('products').select('id,name,price').eq('site_id','70030000').in('price',[10,6]).limit(2);
  const r2=await fetch(`${U}/functions/v1/add-products-to-order`,{method:'POST',headers:H,
    body:JSON.stringify({order_id:id,site_id:'70030000',
      line_items:(prods as any[]).map(p=>({product_id:String(p.id),quantity:1}))})});
  const b2=await r2.json();
  console.log(`[2] add-products -> HTTP ${r2.status}`);
  if(r2.status>=400){ console.log(JSON.stringify(b2).slice(0,300)); return; }

  const {data:o1}=await sb.from('orders').select('line_items,clover_ticket_id,additional_properties,total').eq('id',id).eq('site_id','70030000').single();
  const ids=((o1 as any).line_items??[]).map((l:any)=>l.id);
  console.log(`    lineas=${ids.length} ticket=${(o1 as any).clover_ticket_id??'-'} gestionada=${(o1 as any).additional_properties?.clover_managed??false}`);

  // 3 · FIRE
  const r3=await fetch(`${U}/functions/v1/send-to-kitchen`,{method:'POST',headers:H,
    body:JSON.stringify({order_id:id,site_id:'70030000',line_item_ids:ids})});
  console.log(`[3] send-to-kitchen -> HTTP ${r3.status}`);
  await new Promise(x=>setTimeout(x,2500));

  const {data:o2}=await sb.from('orders').select('line_items,clover_ticket_id,additional_properties,total').eq('id',id).eq('site_id','70030000').single();
  const d:any=o2;
  console.log(`\n[4] MCM: ticket=${d.clover_ticket_id??'NINGUNO'} gestionada=${d.additional_properties?.clover_managed??false} total=${d.total}`);
  for(const l of d.line_items){const c=l.additional_properties?.clover??{};
    console.log(`    ${l.name} status=${l.status??'-'} origin=${c.origin??'-'} ancla=${JSON.stringify(c.line_item_ids??null)}`);}

  if(!d.clover_ticket_id){ console.log('\nFALLA: no se abrio ticket'); return; }
  const rr=await fetch(`${CM}/orders/${d.clover_ticket_id}?expand=lineItems,lineItems.taxRates`,{headers:{Authorization:`Bearer ${CK}`}});
  const t=await rr.json();
  const els=t?.lineItems?.elements??[];
  console.log(`\n[5] CLOVER ${t.id} titulo="${t.title}" lineas=${els.length}`);
  for(const e of els){const tr=e.taxRates?.elements??[];
    console.log(`    ${e.name} ${e.price}c tasas=${tr.length}: ${tr.map((x:any)=>x.name+'='+x.taxAmount).join(' ')}`);}

  // 6 · segundo fire: idempotencia
  const r6=await fetch(`${U}/functions/v1/send-to-kitchen`,{method:'POST',headers:H,
    body:JSON.stringify({order_id:id,site_id:'70030000',line_item_ids:ids})});
  await new Promise(x=>setTimeout(x,2500));
  const rr2=await fetch(`${CM}/orders/${d.clover_ticket_id}?expand=lineItems`,{headers:{Authorization:`Bearer ${CK}`}});
  const n2=((await rr2.json())?.lineItems?.elements??[]).length;
  console.log(`\n[6] 2do fire HTTP ${r6.status} -> CLOVER ${n2} lineas ${n2===els.length?'(PASA, no duplica)':'(FALLA)'}`);
  console.log(`\nORDEN_DE_PRUEBA=${id} TICKET=${d.clover_ticket_id}`);
})();
