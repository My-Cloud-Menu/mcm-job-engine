/* Fase 0 — Clover sandbox smoke test + host gate.
 * Reads Clover creds from DEV site_integrations (site 25512412) via PostgREST (service_role),
 * determines which host authenticates (sandbox.dev vs apisandbox.dev), and smoke-tests
 * merchant/tenders/items. The apiKey (Bearer token) is used but NEVER printed and NEVER
 * written into any repo file — only to the session scratchpad. Non-secret metadata + redacted
 * responses are saved to docs/clover-bidi/evidence/.
 *
 * Usage: node docs/clover-bidi/scripts/00-smoke.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');            // mcm-job-engine
const EVID = path.resolve(__dirname, '../evidence');
const SCRATCH = '/tmp/claude-1000/-home-carlossantos-Documents-Proyectos-MCM/7588c7c9-a8a8-4318-8181-e34f11fefbda/scratchpad';
const SITE_WITH_CREDS = 25512412;

// ---- parse .env (never print values) ----
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).replace(/^"|"$/g, '').trim()]; })
);
const SUPABASE_URL = env.SUPABASE_URL;
const SR = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SR) { console.error('MISSING SUPABASE_URL / SERVICE_ROLE in .env'); process.exit(2); }

const redact = (obj) => {
  const seen = JSON.parse(JSON.stringify(obj));
  const walk = (o) => {
    if (o && typeof o === 'object') for (const k of Object.keys(o)) {
      if (/apikey|token|secret|password|authorization/i.test(k)) o[k] = '<redacted>';
      else walk(o[k]);
    }
  };
  walk(seen);
  return seen;
};
const saveEvidence = (name, data) => {
  fs.mkdirSync(EVID, { recursive: true });
  fs.writeFileSync(path.join(EVID, name), JSON.stringify(data, null, 2));
};

async function main() {
  const out = { step: 'fase0-smoke', ts: new Date().toISOString(), site_with_creds: SITE_WITH_CREDS };

  // ---- 1. read Clover config via PostgREST (service_role bypasses RLS) ----
  const cfgRes = await fetch(
    `${SUPABASE_URL}/rest/v1/site_integrations?site_id=eq.${SITE_WITH_CREDS}&provider=eq.clover&type=eq.pos&select=config,active`,
    { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }
  );
  if (!cfgRes.ok) { console.error('PostgREST read failed', cfgRes.status, await cfgRes.text()); process.exit(3); }
  const rows = await cfgRes.json();
  if (!rows.length) { console.error('No clover integration on site', SITE_WITH_CREDS); process.exit(3); }
  const cfg = rows[0].config || {};
  const apiKey = cfg.apiKey;
  const merchantId = cfg.merchantId;
  const configuredUrl = cfg.apiUrl;
  out.config_present = { apiKey: !!apiKey, apiKey_len: apiKey ? apiKey.length : 0, merchantId, apiUrl: configuredUrl, active: rows[0].active };
  console.log('[creds] apiKey_len=%d merchantId=%s configuredUrl=%s active=%s', out.config_present.apiKey_len, merchantId, configuredUrl, rows[0].active);
  if (!apiKey || !merchantId) { console.error('config missing apiKey/merchantId'); process.exit(3); }

  // ---- 2. host gate: which base URL authenticates GET /v3/merchants/{mId} ----
  const candidates = [...new Set([configuredUrl, 'https://apisandbox.dev.clover.com', 'https://sandbox.dev.clover.com'].filter(Boolean))];
  const H = { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'MyCloudMenu-JobEngine/1.0-clover-bidi' };
  out.host_gate = [];
  let validBase = null, merchantObj = null;
  for (const base of candidates) {
    const url = `${base}/v3/merchants/${merchantId}`;
    let status = null, ok = false, body = null, err = null;
    try {
      const r = await fetch(url, { headers: H });
      status = r.status; ok = r.ok;
      const txt = await r.text();
      try { body = JSON.parse(txt); } catch { body = txt.slice(0, 300); }
    } catch (e) { err = String(e.cause || e); }
    out.host_gate.push({ base, status, ok, err, name: body && body.name });
    console.log('[host-gate] %s -> status=%s ok=%s%s', base, status, ok, err ? ' err=' + err : '');
    if (ok && !validBase) { validBase = base; merchantObj = body; }
  }
  out.valid_base = validBase;
  if (!validBase) { out.result = 'AUTH_FAILED_ALL_HOSTS'; saveEvidence('00-smoke.json', redact(out)); console.error('NO HOST AUTHENTICATED — see evidence'); process.exit(4); }
  console.log('[host-gate] VALID BASE = %s (merchant="%s")', validBase, merchantObj && merchantObj.name);

  // ---- 3. smoke: tenders + items ----
  const getJson = async (p) => {
    const r = await fetch(`${validBase}/v3/merchants/${merchantId}${p}`, { headers: H });
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt.slice(0, 300); }
    return { status: r.status, ok: r.ok, body: j };
  };
  const tenders = await getJson('/tenders?limit=100');
  const items = await getJson('/items?limit=1');
  out.merchant = merchantObj && { id: merchantObj.id, name: merchantObj.name };
  out.tenders = { status: tenders.status, count: tenders.body && tenders.body.elements ? tenders.body.elements.length : null,
    elements: tenders.body && tenders.body.elements ? tenders.body.elements.map(t => ({ id: t.id, label: t.label, labelKey: t.labelKey, enabled: t.enabled })) : tenders.body };
  out.items = { status: items.status, sample_count: items.body && items.body.elements ? items.body.elements.length : null };
  console.log('[smoke] tenders status=%s count=%s', out.tenders.status, out.tenders.count);
  console.log('[smoke] items    status=%s sample=%s', out.items.status, out.items.sample_count);
  if (out.tenders.elements && Array.isArray(out.tenders.elements))
    out.tenders.elements.forEach(t => console.log('        tender: id=%s label="%s" labelKey=%s enabled=%s', t.id, t.label, t.labelKey, t.enabled));

  // ---- 4. write creds to scratchpad (outside all repos) for later scripts ----
  fs.mkdirSync(SCRATCH, { recursive: true });
  const credLines = [
    `CLOVER_SANDBOX_MERCHANT_ID=${merchantId}`,
    `CLOVER_SANDBOX_API_TOKEN=${apiKey}`,
    `CLOVER_SANDBOX_API_BASE_URL=${validBase}`,
    `SUPABASE_URL=${SUPABASE_URL}`,
    `SUPABASE_SERVICE_ROLE_KEY=${SR}`,
    `DATABASE_URL=${env.DATABASE_URL || ''}`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(SCRATCH, 'clover-sandbox.env'), credLines, { mode: 0o600 });
  out.creds_written_to = path.join(SCRATCH, 'clover-sandbox.env') + ' (scratchpad, outside git)';
  console.log('[creds] written to scratchpad (token not printed)');

  out.result = 'OK';
  saveEvidence('00-smoke.json', redact(out));
  console.log('[done] evidence saved (redacted). VALID BASE=%s', validBase);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
