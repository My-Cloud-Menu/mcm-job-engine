import { syncOnce, SITE_ID } from './harness';
(async () => {
  for (let i = 1; i <= 4; i++) {
    try { const r = await syncOnce(SITE_ID); console.log(`sync #${i}: ${JSON.stringify(r)}`); }
    catch (e:any) { console.log(`sync #${i}: ERR ${e?.code ?? e?.message}`); }
  }
  process.exit(0);
})();
