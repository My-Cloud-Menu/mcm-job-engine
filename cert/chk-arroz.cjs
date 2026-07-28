const L=require('./lib.cjs');
(async()=>{
  for(const id of ['300155','300110','300025']){
    const r=await L.omni.call('GET',`/menu/items/${id}/`);
    const i=r.body;
    console.log(`\n${id} "${i?.name}"  price_per_unit=${i?.price_per_unit}  open=${i?.open}  in_stock=${i?.in_stock}`);
    const pl=await L.omni.call('GET',`/menu/items/${id}/price_levels/`);
    const levels=pl.body?._embedded?.price_levels||[];
    console.log(`   price_levels (${levels.length}): ${levels.map(l=>`${l.id}:${l.name}=${l.price_per_unit}`).join(' | ')}`);
  }
  await L.db.close();
})();
