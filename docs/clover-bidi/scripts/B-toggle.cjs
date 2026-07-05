/* Toggle a Clover sandbox item's `available` flag (for the 86 test). Restores after.
 * Usage: node B-toggle.cjs <itemId> <true|false> */
const fs = require('fs');
const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const env = Object.fromEntries(fs.readFileSync(SCRATCH + '/clover-sandbox.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const BASE = env.CLOVER_SANDBOX_API_BASE_URL, MID = env.CLOVER_SANDBOX_MERCHANT_ID, TOK = env.CLOVER_SANDBOX_API_TOKEN;
const itemId = process.argv[2], available = process.argv[3] === 'true';
(async () => {
  const r = await fetch(`${BASE}/v3/merchants/${MID}/items/${itemId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', 'User-Agent': 'MyCloudMenu-JobEngine/1.0-clover-bidi' },
    body: JSON.stringify({ available }),
  });
  const j = await r.json();
  console.log(`item ${itemId} -> status=${r.status} available=${j.available}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
