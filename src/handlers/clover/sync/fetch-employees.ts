import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { trackEvent } from '../../../observability/posthog';
import { mapCloverError } from '../error-map';
import { fetchAllCloverElements } from './catalog-sync';
import { enqueueAlert } from '../../../observability/alerts';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/**
 * ¿Es SEGURO aplicar estas bajas, o el listado vino degradado?
 *
 * El flag `complete` de `fetchAllCloverElements` NO sirve aquí: `/employees` usa el modo OFFSET
 * (a propósito — un merchant no tiene 1000 empleados) y ese modo devuelve `complete:true` en
 * cuanto una página trae menos de 100. Un 200 corto se lee como barrido completo. El modo cursor
 * tampoco lo detectaría. Para empleados el cap de merma es la defensa ENTERA, y por eso es
 * estrecho.
 *
 * Diferencias con el `archiveIsSafe` del catálogo, y son deliberadas:
 *
 *  · **El numerador es real, no estimado.** El del catálogo resta (`existentes - presentes`); aquí
 *    esa resta MIENTE, porque el listado incluye a los empleados sin PIN, que se descartan
 *    (`skipped_no_pin`) y nunca fueron candidatos. Se cuentan las bajas de verdad.
 *  · **El suelo absoluto es 2, no 10.** El 10 del catálogo es razonable entre miles de ítems y
 *    ridículo en una plantilla: con 20 empleados dejaría desactivar a 10 —media plantilla— y lo
 *    llamaría seguro; con 7, a los 7. Con `max(2, 15%)`: 7 → 2 · 12 → 2 · 20 → 3 · 67 → 10 · 165 → 24.
 *    Dos bajas simultáneas son lo normal y pasan; un barrido degradado no.
 *  · **Todo o nada.** Aplicar "las primeras 2 y saltarse el resto" sería arbitrario.
 */
export const EMPLEADOS_MERMA_RATIO = 0.15;
export const EMPLEADOS_MERMA_ABS = 2;
export function bajasSonSeguras(presentes: number, gestionados: number, aDesactivar: number): boolean {
  if (presentes === 0 || gestionados === 0) return false;
  const cap = Math.max(EMPLEADOS_MERMA_ABS, Math.floor(gestionados * EMPLEADOS_MERMA_RATIO));
  return aDesactivar <= cap;
}

/** Map a Clover role to an MCM role. POS ADMIN/MANAGER → 'manager' (never grants MCM 'admin'
 *  from the POS); everything else → 'waiter'. Never downgrades an existing MCM 'admin'. */
function mapRole(cloverRole: string | undefined, prevRole: string | undefined): string {
  if (prevRole === 'admin') return 'admin';
  const r = String(cloverRole ?? '').toUpperCase();
  return r === 'ADMIN' || r === 'MANAGER' ? 'manager' : 'waiter';
}

function splitName(full: string | undefined): { first: string; last: string } {
  const s = String(full ?? '').trim();
  if (!s) return { first: '', last: '' };
  const i = s.indexOf(' ');
  return i < 0 ? { first: s, last: '' } : { first: s.slice(0, i), last: s.slice(i + 1) };
}

/**
 * Recurring + on-demand Clover → MCM EMPLOYEE sync (ADDITIVE). Mirrors the Omnivore employee
 * sync: match key `(site_id, login)` where **login = Clover `unhashedPin`** (the PIN). The
 * Clover employee id is stored in `pos_id`. Role mapped conservatively; an existing MCM 'admin'
 * is never downgraded. Additive: never deletes employees. Gated by `config.sync_employees`.
 *
 * NOTE (verified in the sandbox, P1.4): Clover only returns `unhashedPin` when the merchant
 * enables passcode login AND the token has PIN visibility. Employees WITHOUT a PIN cannot be
 * keyed by (site_id, login) and are counted as `skipped_no_pin` (event
 * `clover_employee_pin_unmatched`), NOT dropped silently.
 */
registerHandler('clover', 'fetch_employees', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const cloverConfig = CloverConfigSchema.parse(config);

  // The flag gates SCHEDULED runs only; a manual "sync now" always runs.
  if ((cloverConfig as any).sync_employees !== true && !isManual) {
    if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    return { skipped_reason: 'sync_employees_disabled' };
  }

  const client = createCloverClient(cloverConfig, job.correlation_id, job.site_id);
  const started = Date.now();

  let created = 0, updated = 0, skippedNoPin = 0, total = 0, deactivated = 0, reactivated = 0;
  let deactivationSkipped: string | null = null;
  let borradosFiltrados = 0;
  // Bandera de site: desactivar en MCM a los empleados que Clover ya no devuelve.
  const desactivarBajas = (cloverConfig as any).cloverDeactivateRemovedEmployees === true;
  try {
    const { elements: crudos, complete } = await fetchAllCloverElements(client, job.site_id, '/employees');
    // Los soft-deletes NO cuentan como vivos. El catálogo ya los filtra (`syncCloverCategories`,
    // `syncCloverProducts`); empleados no lo hacía, y si un merchant los devuelve con `deleted:true`
    // su id entraba en el conjunto de vivos y la desactivación se volvía un NO-OP silencioso: el
    // despedido conservaba su PIN y el log decía que todo fue bien.
    const elements = (crudos ?? []).filter((e: any) => e?.deleted !== true);
    borradosFiltrados = (crudos ?? []).length - elements.length;
    total = elements.length;

    // existing rows for admin-protection + change diff
    const { data: existingRows, error: readErr } = await supabase
      .from('employees')
      .select('login, first_name, last_name, pos_id, check_name, role, is_active, additional_properties')
      .eq('site_id', job.site_id);
    if (readErr) throw readErr;
    const existing = new Map<string, any>();
    for (const r of existingRows ?? []) existing.set(String((r as any).login), r);

    const toWrite: Record<string, unknown>[] = [];
    const aReactivar: Array<{ login: string; ap: Record<string, unknown> }> = [];
    // Los PIN que Clover reconoce AHORA. Es la llave de "sigue vivo" (ver el bloque de bajas).
    const loginsVivos = new Set<string>();
    for (const e of elements) {
      // Production merchants return the passcode in `pin` (verified live, merchant
      // 7HDQDCV6WGNB1); the sandbox exposed it as `unhashedPin`. Accept either.
      const rawPin = e.unhashedPin ?? e.pin;
      const login = rawPin != null && String(rawPin) !== '' ? String(rawPin) : '';
      if (!login) { skippedNoPin++; continue; }
      loginsVivos.add(login);
      const prev = existing.get(login);
      const { first, last } = splitName(e.name);
      const row = {
        site_id: job.site_id,
        login,
        first_name: first,
        last_name: last,
        pos_id: e.id != null ? String(e.id) : '',
        check_name: e.nickname ?? '',
        role: mapRole(e.role, prev?.role),
      };
      if (!prev) { created++; toWrite.push(row); continue; }

      // ── Recontratado ────────────────────────────────────────────────────────────────
      // Sólo se reactiva a quien desactivó ESTE sync (marcador `clover_roster_absent`). Una baja
      // hecha a mano desde `/employees` NO lleva marcador y por tanto no se toca: el dueño archiva
      // a alguien suspendido que sigue existiendo en Clover, y sin esta distinción el sync de las
      // 3 de la mañana le devolvería el PIN.
      //
      // OJO — la reactivación va como UPDATE dirigido, **nunca dentro del lote del upsert**.
      // postgrest-js manda `columns=<unión de las claves de TODAS las filas>` y NO manda
      // `Prefer: missing=default`, así que PostgREST rellena con NULL las columnas ausentes de cada
      // fila. Como `employees.is_active` es `NOT NULL`, meter `is_active` sólo en algunas filas de
      // un lote mixto reventaría el lote entero con un 23502 y tumbaría el sync completo.
      // (Omnivore hace exactamente eso en `employees-sync.ts`: es un fallo latente suyo que aún no
      // ha disparado porque su bandera es opt-in y no hay inactivos. No se copia.)
      if (prev.is_active === false && prev.additional_properties?.clover_roster_absent === true) {
        aReactivar.push({ login, ap: prev.additional_properties ?? {} });
      }

      const changed =
        (prev.first_name ?? '') !== row.first_name || (prev.last_name ?? '') !== row.last_name ||
        (prev.pos_id ?? '') !== row.pos_id || (prev.check_name ?? '') !== row.check_name ||
        (prev.role ?? '') !== row.role;
      if (changed) { updated++; toWrite.push(row); }
    }

    const CHUNK = 500;
    for (let i = 0; i < toWrite.length; i += CHUNK) {
      const { error } = await supabase.from('employees').upsert(toWrite.slice(i, i + CHUNK), { onConflict: 'site_id,login' });
      if (error) throw error;
    }

    // ── Reactivar a los recontratados (UPDATE dirigido, nunca en el lote) ──────────────────
    for (const r of aReactivar) {
      const { error } = await supabase.from('employees')
        .update({ is_active: true, additional_properties: { ...r.ap, clover_roster_absent: false } })
        .eq('site_id', job.site_id).eq('login', r.login);   // multi-tenant: SIEMPRE
      if (error) throw error;
      reactivated++;
    }
    if (reactivated > 0) {
      logger.info({ site_id: job.site_id, reactivated, logins: aReactivar.map((r) => r.login) },
        'clover_employees_reactivated');
    }

    // ── Desactivar a quien ya NO está en Clover ─────────────────────────────────────────────
    // El sync era ADITIVO: un empleado despedido y borrado en Clover conservaba su PIN y
    // **seguía entrando al POS** (medido: `verify-employee-pin` devolvía `ok:true`).
    //
    // El criterio tiene dos mitades, y hay que mantenerlas SEPARADAS:
    //   1. «¿esta fila vino de Clover?» → tiene `pos_id`. Protege a los empleados NATIVOS de MCM
    //      (creados a mano, sin `pos_id`), que tampoco están en Clover y quedarían fuera de golpe.
    //   2. «¿sigue viva?» → su `login` está entre los PIN que Clover devuelve AHORA.
    //
    // La versión anterior usaba `pos_id` para LAS DOS, y ahí estaba el agujero: si Clover rota el
    // PIN de alguien (mismo id, distinto pin), el upsert por `(site_id, login)` crea una fila nueva
    // y la vieja se queda **activa con el PIN antiguo**, que sigue abriendo el POS — porque su
    // `pos_id` sí sigue en el listado. Casando por `login` esa fila huérfana cae sola por el camino
    // normal, sin rama especial ni heurística. Es la forma que ya usa Omnivore.
    //
    // Efecto conocido y aceptado: `updateEmployee` del dashboard deja cambiar el `login`. Si
    // alguien edita en MCM el PIN de un empleado de Clover, el sync desactiva esa fila y deja viva
    // la que trae el PIN de Clover. Es la semántica del modo gestionado (Clover manda, MCM lee) y
    // converge a UNA fila activa; la regla vieja dejaba DOS, ambas abriendo el POS.
    if (desactivarBajas) {
      const gestionados = (existingRows ?? []).filter((r: any) => String(r.pos_id ?? '') !== '').length;
      const bajas = (existingRows ?? []).filter((r: any) => {
        const posId = String(r.pos_id ?? '');
        return posId !== '' && !loginsVivos.has(String(r.login ?? '')) && r.is_active !== false;
      });

      if (bajas.length === 0) {
        // nada que hacer
      } else if (!bajasSonSeguras(loginsVivos.size, gestionados, bajas.length)) {
        // Suelo anti-wipe. NO es cosmético: un listado degradado (200 corto, página perdida) se lee
        // como barrido completo en modo offset, y sin esto desactivaría a media plantilla de golpe.
        deactivationSkipped = `merma sospechosa: ${bajas.length} bajas sobre ${gestionados} gestionados (vivos: ${loginsVivos.size})`;
        logger.warn({ site_id: job.site_id, vivos: loginsVivos.size, gestionados, bajas: bajas.length, complete },
          'clover_employees_deactivation_skipped_suspicious');
        // Se AVISA. Un despido que no se aplica es tan grave como una plantilla borrada, y hasta
        // ahora el único rastro era un log que rota.
        // `enqueueAlert` ya coalesce duplicados en 5 min y se traga sus propios errores: una
        // alerta que no sale nunca puede tumbar el sync.
        await enqueueAlert({
          dedupeKey: `clover_employee_wipe_guard:${job.site_id}`,
          severity: 'warning',
          eventType: 'clover_employee_deactivation_blocked',
          subject: `Bajas de empleados de Clover bloqueadas (site ${job.site_id})`,
          body:
            `El sync iba a desactivar ${bajas.length} de ${gestionados} empleados vinculados a Clover ` +
            `y se ha detenido por si el listado vino incompleto.\n\n` +
            `NADIE ha perdido el acceso — pero las bajas reales tampoco se han aplicado, así que un ` +
            `empleado dado de baja en Clover puede seguir entrando con su PIN.\n\n` +
            `Revisar el roster en Clover y volver a lanzar el sync.`,
          metadata: { vivos: loginsVivos.size, gestionados, bajas: bajas.length, complete },
          siteId: job.site_id,
          integration: 'clover',
        });
      } else {
        for (const b of bajas) {
          const { error } = await supabase.from('employees')
            .update({
              is_active: false,
              // Marca la baja como AUTOMÁTICA, para poder reactivar al recontratado sin pisar una
              // baja hecha a mano (que no lleva marcador).
              additional_properties: { ...((b as any).additional_properties ?? {}), clover_roster_absent: true },
            })
            .eq('site_id', job.site_id).eq('login', (b as any).login);   // multi-tenant: SIEMPRE
          if (error) throw error;
          deactivated++;
        }
        if (deactivated > 0) {
          logger.info({ site_id: job.site_id, deactivated, logins: bajas.map((b: any) => b.login) },
            'clover_employees_deactivated');
        }
      }
    }
  } catch (err) {
    throw mapCloverError(err, 'CLOVER_FETCH_EMPLOYEES_FAILED');
  }

  const duration = Date.now() - started;
  const result = {
    total, created, updated, deactivated, reactivated,
    deactivation_skipped: deactivationSkipped,
    deleted_filtered: borradosFiltrados,
    skipped_no_pin: skippedNoPin, duration_ms: duration,
  };

  try {
    await supabase.from('clover_employee_sync_log').insert({
      site_id: job.site_id, merchant_id: cloverConfig.merchantId,
      source: isManual ? 'manual' : 'scheduled', duration_ms: duration,
      employees_total: total, employees_created: created, employees_updated: updated,
      employees_skipped_no_pin: skippedNoPin, status: 'ok',
      // Migración 036: sin esto una desactivación masiva no dejaba rastro consultable.
      employees_deactivated: deactivated, employees_reactivated: reactivated,
      deactivation_skipped_reason: deactivationSkipped,
    });
  } catch (e) {
    logger.warn({ site_id: job.site_id, err: String((e as Error).message) }, 'clover_employee_sync_log insert skipped');
  }

  if (skippedNoPin > 0) trackEvent('clover_employee_pin_unmatched', { site_id: job.site_id, count: skippedNoPin, total });
  logger.info({ site_id: job.site_id, ...result }, 'clover fetch_employees completed');

  if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  return result as unknown as Record<string, unknown>;
});
