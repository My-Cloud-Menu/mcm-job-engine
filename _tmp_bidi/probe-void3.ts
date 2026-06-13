import { OMNI, omniItems, omniCreateTicket } from './harness';
const MI_GUAC='300020';
(async () => {
  const tid = await omniCreateTicket(`VP3-${Date.now()%100000}`, '102');
  if(!tid){console.log('create fail');process.exit(1);}
  // item ENVIADO (auto_send:true) — el caso real de MCM
  await OMNI('POST', `/tickets/${tid}/items`, { items:[{menu_item:MI_GUAC, quantity:1, item_order_mode:'0', auto_send:true}] }, `vp3_add:${tid}`);
  let items = await omniItems(tid);
  console.log('item sent:', JSON.stringify(items.map((i:any)=>({id:i.id,sent:i.sent}))));
  const it = items[0];
  if(!it){process.exit(0);}
  const v2 = await OMNI('DELETE', `/tickets/${tid}/items/${it.id}`, undefined, `vp3_del:${it.id}`);
  console.log(`DELETE sent item /items/${it.id} → status=${v2.status} ${JSON.stringify(v2.d?.errors ?? 'ok').slice(0,200)}`);
  console.log('items after delete:', (await omniItems(tid)).length);
  console.log(`(ticket ${tid})`);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
