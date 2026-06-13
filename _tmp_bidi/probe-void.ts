import { OMNI, omniItems, sb, SITE_ID } from './harness';
const TICKET = '20260612-1010005';
(async () => {
  const items = await omniItems(TICKET);
  console.log('Omnivore items en ticket abierto:', JSON.stringify(items.map((i:any)=>({id:i.id,name:i.name,sent:i.sent}))));
  const sent = items.find((i:any)=>i.sent);
  if (!sent) { console.log('no sent item'); process.exit(0); }
  console.log(`\nIntentando void DIRECTO del item ${sent.id} (${sent.name}, sent=${sent.sent})...`);
  const { status, d } = await OMNI('POST', `/tickets/${TICKET}/items/${sent.id}/void`, {}, `probe_void:${sent.id}`);
  console.log('VOID status=', status);
  console.log('VOID resp=', JSON.stringify(d).slice(0,500));
  // sync_status guardado por MCM en el item voided (orden 10039)
  const { data } = await sb.from('orders').select('line_items').eq('id',10039).eq('site_id',SITE_ID).maybeSingle();
  const g = (data?.line_items??[]).find((i:any)=>i.name?.includes('Guac'));
  console.log('\nMCM Guac voided item omnivore block:', JSON.stringify(g?.additional_properties?.omnivore));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
