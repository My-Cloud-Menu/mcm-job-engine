import { OMNI, omniItems, omniCreateTicket } from './harness';
const MI_GUAC='300020';
(async () => {
  const tid = await omniCreateTicket(`VOIDPROBE-${Date.now()%100000}`, '102');
  if(!tid){console.log('create fail');process.exit(1);}
  // item NO enviado (auto_send:false)
  const add = await OMNI('POST', `/tickets/${tid}/items`, { items:[{menu_item:MI_GUAC, quantity:1, item_order_mode:'0', auto_send:false}] }, `vp_add:${tid}`);
  console.log('add unsent status=', add.status);
  let items = await omniItems(tid);
  console.log('items:', JSON.stringify(items.map((i:any)=>({id:i.id,sent:i.sent}))));
  const it = items[0];
  if(!it){console.log('no item created');process.exit(0);}
  // probar POST /void
  const v1 = await OMNI('POST', `/tickets/${tid}/items/${it.id}/void`, { void_type:null }, `vp_void:${it.id}`);
  console.log(`POST /items/${it.id}/void → status=${v1.status} ${JSON.stringify(v1.d).slice(0,200)}`);
  items = await omniItems(tid);
  console.log('items after void attempt:', items.length);
  // si sigue, probar DELETE
  if(items.length){
    const v2 = await OMNI('DELETE', `/tickets/${tid}/items/${it.id}`, undefined, `vp_del:${it.id}`);
    console.log(`DELETE /items/${it.id} → status=${v2.status} ${JSON.stringify(v2.d).slice(0,200)}`);
    console.log('items after delete:', (await omniItems(tid)).length);
  }
  console.log(`\n(ticket de prueba ${tid})`);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
