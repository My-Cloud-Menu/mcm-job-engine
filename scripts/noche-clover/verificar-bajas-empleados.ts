/** Un empleado borrado en Clover debe perder el acceso al POS; uno nativo de MCM, jamás. */
import { supabase } from '../../src/lib/supabase';
import { getSiteIntegrationConfig, invalidateCredentialsCache } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';
import '../../src/handlers/clover/sync/fetch-employees';
import { getHandler } from '../../src/handlers/registry';

const SITE = 99990004;
const ok: string[] = []; const mal: string[] = [];
const chk = (n: string, c: boolean, d = '') => { (c ? ok : mal).push(n); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };
const sync = () => getHandler('clover', 'fetch_employees')!({
  stepInput: { schedule_id: null, manual: true }, jobPayload: { manual: true }, context: {},
  job: { id: 'b', site_id: SITE, correlation_id: 'b' } as any,
  step: { idempotency_key: 'b', attempt_count: 0, max_attempts: 1 } as any } as any) as Promise<any>;
const login = async (pin: string) => {
  const r = await fetch('https://blbelbdvykpvbeqbjqom.supabase.co/functions/v1/verify-employee-pin',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: SITE, pin }) });
  return (await r.json()) as any;
};

(async () => {
  const { data: si } = await supabase.from('site_integrations').select('id, config')
    .eq('site_id', SITE).eq('provider', 'clover').eq('type', 'pos').single();
  const FID = (si as any).id; const cfgOrig = (si as any).config;
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cl = createCloverClient(CloverConfigSchema.parse(config), 'b', SITE);
  const e = (await cl.post<any>('/employees', { name: 'Baja Prueba', role: 'EMPLOYEE' })).data;
  const PIN = String(e.pin);
  try {
    await supabase.from('site_integrations')
      .update({ config: { ...cfgOrig, cloverDeactivateRemovedEmployees: true } })
      .eq('id', FID).eq('site_id', SITE);
    invalidateCredentialsCache(SITE, 'clover');

    await sync();
    chk('el empleado de Clover entra al POS', (await login(PIN)).ok === true, `pin=${PIN}`);
    chk('el gerente NATIVO de MCM también', (await login('9911')).ok === true);

    await cl.delete(`/employees/${e.id}`);
    const r: any = await sync();
    console.log(`  sync tras el borrado -> ${JSON.stringify(r)}`);

    const l1 = await login(PIN);
    chk('el DESPEDIDO ya NO entra al POS', l1.ok !== true, JSON.stringify(l1).slice(0, 60));
    const l2 = await login('9911');
    chk('el NATIVO de MCM sigue entrando (no se toca a quien no vino de Clover)', l2.ok === true);
    const { data: nativos } = await supabase.from('employees').select('login, is_active, pos_id')
      .eq('site_id', SITE).or('pos_id.is.null,pos_id.eq.');
    chk('ningún empleado sin pos_id quedó desactivado',
        (nativos ?? []).every((x: any) => x.is_active !== false),
        (nativos ?? []).map((x: any) => `${x.login}:${x.is_active}`).join(', '));

    const r2: any = await sync();
    chk('idempotente: una segunda pasada no desactiva a nadie más', r2.deactivated === 0, `deactivated=${r2.deactivated}`);
  } finally {
    await supabase.from('employees').delete().eq('site_id', SITE).eq('login', PIN);
    await supabase.from('site_integrations').update({ config: cfgOrig }).eq('id', FID).eq('site_id', SITE);
    invalidateCredentialsCache(SITE, 'clover');
    const { data: c } = await supabase.from('site_integrations').select('config').eq('id', FID).single();
    console.log(`\n  bandera restaurada: cloverDeactivateRemovedEmployees=${(c as any).config.cloverDeactivateRemovedEmployees ?? '(ausente)'}`);
  }
  console.log(`\nRESULTADO: ${ok.length} OK · ${mal.length} FALLAN`);
  if (mal.length) process.exit(1);
})().catch((e) => { console.error('ERR', e?.message); process.exit(1); });
