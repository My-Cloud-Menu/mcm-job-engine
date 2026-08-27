/**
 * EN VIVO · reactivación del recontratado vs. baja hecha a mano.
 *
 * Las dos ramas nuevas del sync de empleados, contra el merchant sandbox real:
 *   · quien desactivó ESTE sync (marcador `clover_roster_absent`) y vuelve al roster → se reactiva.
 *   · quien archivó una PERSONA desde `/employees` (sin marcador) → NO se toca, aunque siga en Clover.
 *
 * La segunda es la que importa: sin la distinción, el dueño archiva a alguien suspendido y el sync
 * de las 3 de la mañana le devuelve el PIN.
 *
 * Sólo toca el banco 99990004. Deja el estado como lo encontró.
 */
import './../../src/handlers/clover/sync/fetch-employees';
import { getHandler } from '../../src/handlers/registry';
import { supabase } from '../../src/lib/supabase';

const SITE = 99990004;
const ok: string[] = [], mal: string[] = [];
const check = (n: string, c: boolean, d = '') => {
  (c ? ok : mal).push(n); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`);
};
const correr = () => getHandler('clover', 'fetch_employees')!({
  stepInput: { schedule_id: null, manual: true }, jobPayload: { manual: true }, context: {},
  job: { id: 'v', site_id: SITE, correlation_id: 'v' } as any,
  step: { idempotency_key: 'v', attempt_count: 0, max_attempts: 1 } as any } as any) as Promise<any>;

const leer = async (login: string) => (await supabase.from('employees')
  .select('login, is_active, additional_properties').eq('site_id', SITE).eq('login', login).maybeSingle()).data as any;

async function main() {
  // dos empleados REALES que Clover devuelve ahora mismo
  const { data: vivos } = await supabase.from('employees')
    .select('login, is_active, additional_properties').eq('site_id', SITE)
    .neq('pos_id', '').eq('is_active', true).limit(2);
  if ((vivos ?? []).length < 2) throw new Error('hacen falta 2 empleados de Clover activos');
  const [A, B] = vivos as any[];
  const original = new Map<string, any>([[A.login, A.additional_properties], [B.login, B.additional_properties]]);
  console.log(`\nA=${A.login} (simula recontratado)   B=${B.login} (simula baja manual)\n`);

  // A: como si lo hubiera desactivado el sync
  await supabase.from('employees')
    .update({ is_active: false, additional_properties: { ...(A.additional_properties ?? {}), clover_roster_absent: true } })
    .eq('site_id', SITE).eq('login', A.login);
  // B: como si lo hubiera archivado una persona desde /employees (SIN marcador)
  await supabase.from('employees')
    .update({ is_active: false, additional_properties: A.additional_properties ?? null })
    .eq('site_id', SITE).eq('login', B.login);

  const r = await correr();
  console.log(`  sync -> reactivated=${r.reactivated} deactivated=${r.deactivated}\n`);

  const a2 = await leer(A.login), b2 = await leer(B.login);
  check('el RECONTRATADO recupera su PIN', a2.is_active === true, `is_active=${a2.is_active}`);
  check('y se le limpia el marcador', a2.additional_properties?.clover_roster_absent === false);
  check('la BAJA MANUAL sigue de baja (el sync no le devuelve el PIN)', b2.is_active === false,
        `is_active=${b2.is_active}`);
  check('el contador queda auditado', r.reactivated === 1, `reactivated=${r.reactivated}`);

  // dejar todo como estaba
  for (const [login, ap] of original) {
    await supabase.from('employees').update({ is_active: true, additional_properties: ap })
      .eq('site_id', SITE).eq('login', login);
  }
  console.log('\n  estado restaurado');
  console.log(`\nRESULTADO: ${ok.length} OK · ${mal.length} FALLAN`);
  process.exit(mal.length ? 1 : 0);
}
main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
