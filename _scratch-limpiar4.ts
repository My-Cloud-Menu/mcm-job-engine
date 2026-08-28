import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();
const sb=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!);
const CK='f3ad633c-fac0-f4dc-9b36-50336d8a3d73';
const CM='https://api.clover.com/v3/merchants/YQ8J5VA6RFRP1';
const H={Authorization:`Bearer ${CK}`};
(async()=>{
  const {data}=await sb.from('orders').select('id,clover_ticket_id,customer,total,status')
    .eq('site_id','70030000').gte('id',10038);
  console.log('ordenes de prueba mias:');
  for(const o of (data??[]) as any[]) console.log(`  ${o.id} ${o.status} ticket=${o.clover_ticket_id??'-'} total=${o.total} cliente=${o.customer?.first_name??''}`);

  // PRIMERO los tickets, DESPUES las filas (si no, el pull las repone)
  for(const o of (data??[]) as any[]){
    if(o.clover_ticket_id){
      await fetch(`${CM}/orders/${o.clover_ticket_id}`,{method:'DELETE',headers:H});
      const g=await fetch(`${CM}/orders/${o.clover_ticket_id}`,{headers:H});
      console.log(`  ticket ${o.clover_ticket_id} -> GET ${g.status} ${g.status===404?'(borrado)':'(OJO vivo)'}`);
    }
  }
  for(const o of (data??[]) as any[]){
    await sb.from('payments').delete().eq('site_id','70030000').eq('order_id',o.id);
    const {error}=await sb.from('orders').delete().eq('id',o.id).eq('site_id','70030000');
    console.log(`  orden ${o.id}: ${error?'ERROR '+error.message:'borrada'}`);
  }
  await new Promise(r=>setTimeout(r,25000));
  const {count}=await sb.from('orders').select('*',{count:'exact',head:true}).eq('site_id','70030000').gte('id',10038);
  console.log(`\ntras un ciclo de sync, ordenes >=10038: ${count}`);
})();
