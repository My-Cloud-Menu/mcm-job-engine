import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapCloverError } from '../error-map';
import { readAllBySite } from '../../omnivore/sync/inventory/supabase-read';
import { fetchCloverTablesAndSections, MesaClover } from './table-mapper';
import { resolveSiteLocationId } from '../../../lib/site-location';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
});

/** Igual que en el catálogo: no archivar en masa si el barrido vino raro. */
const ARCHIVE_MAX_SHRINK_RATIO = 0.15;
const ARCHIVE_MAX_SHRINK_ABS = 10;
const archivarEsSeguro = (completo: boolean, presentes: number, existentes: number, aArchivar: number) =>
  completo && presentes > 0 && existentes > 0 &&
  aArchivar <= Math.max(ARCHIVE_MAX_SHRINK_ABS, Math.floor(existentes * ARCHIVE_MAX_SHRINK_RATIO));

/**
 * Clover → MCM: MESAS y SECCIONES hacia el módulo de plano (`floor_elements`).
 *
 * Espeja las reglas que ya tiene Omnivore, porque están puestas por razones que se pagaron caras:
 *
 *  - **Las mesas importadas NACEN ARCHIVADAS** (`archived_at`, `metadata.archived_reason='import'`).
 *    Un POS puede tener cientos de mesas y volcarlas de golpe en el plano lo deja inservible. El
 *    negocio las va sacando del archivo según las coloca.
 *  - **El layout NO se toca nunca.** `x`, `y`, `width`, `height`, `rotation`, `shape` y `z_index`
 *    son de MCM: los coloca una persona arrastrando en el plano. Clover ni los da de forma fiable
 *    ni tendría sentido pisarlos.
 *  - **El nombre respeta el override local**, igual que el catálogo (ver `local-overrides.ts`):
 *    si alguien renombró la mesa en MCM, el sync no se lo pisa.
 *  - **Nunca se borra**: se archiva, con suelo de seguridad, y **jamás una mesa con orden viva**.
 *
 * Gateado por `sync_tables`. Una corrida manual (`trigger_sync_now`) ignora la bandera.
 */
registerHandler('clover', 'fetch_tables', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const isManual = input.manual === true || (jobPayload as Record<string, unknown>)?.manual === true;

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover', 'pos');
  const cloverConfig = CloverConfigSchema.parse(config);

  if ((cloverConfig as any).sync_tables !== true && !isManual) {
    if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    return { skipped_reason: 'sync_tables_disabled' };
  }

  const client = createCloverClient(cloverConfig, job.correlation_id, job.site_id);
  const inicio = Date.now();

  let mesas: MesaClover[] = [];
  let secciones: any[] = [];
  let completo = true;
  try {
    ({ mesas, secciones, completo } = await fetchCloverTablesAndSections(client));
  } catch (err) {
    throw mapCloverError(err, 'CLOVER_FETCH_TABLES_FAILED');
  }

  // El plano: uno por merchant para las mesas de Clover. Se crea sólo si hay algo que colocar.
  //
  // OJO con el `external_id`: el índice único es `(site_id, external_source, external_id)`, así que
  // DOS planos `clover` del mismo site son legales si difiere el merchant. Buscando sólo por
  // `(site_id, 'clover')`, en cuanto existieran dos el `.maybeSingle()` devolvería PGRST116 →
  // `data` null → se insertaría un TERCERO, y otro más en cada corrida. Estado absorbente. Por eso
  // se filtra también por `external_id` y **se mira el error** en vez de descartarlo.
  let planId: string | null = null;
  {
    const { data, error: errBusca } = await supabase.from('floor_plans').select('id')
      .eq('site_id', job.site_id)
      .eq('external_source', 'clover')
      .eq('external_id', cloverConfig.merchantId)
      .maybeSingle();
    if (errBusca) throw errBusca;
    planId = (data as any)?.id ?? null;

    if (!planId && mesas.length > 0) {
      // La sucursal, SÓLO al crear. En las corridas siguientes se reutiliza el plano existente y
      // NO se repisa `location_id`: alguien puede moverlo de sucursal a mano desde el editor, y un
      // sync de 24 h que lo arrastrase de vuelta cada noche sería un tira y afloja invisible.
      const locationId = await resolveSiteLocationId(job.site_id);

      // `display_order` al final, como Omnivore. Sin esto queda en 0 y el plano de Clover se cuela
      // por delante de los que montó el negocio a mano.
      const { data: ultimo } = await supabase.from('floor_plans')
        .select('display_order').eq('site_id', job.site_id)
        .order('display_order', { ascending: false }).limit(1).maybeSingle();
      const orden = Number((ultimo as any)?.display_order ?? -1) + 1;

      const { data: nuevo, error } = await supabase.from('floor_plans')
        .insert({
          site_id: job.site_id, location_id: locationId, name: 'Clover', is_active: true,
          display_order: orden,
          external_source: 'clover', external_id: cloverConfig.merchantId,
        })
        .select('id').single();
      if (error) throw error;
      planId = (nuevo as any).id;
      logger.info({ site_id: job.site_id, plan_id: planId, location_id: locationId, display_order: orden },
        'clover_floor_plan_created');
    }
  }

  const existentes = await readAllBySite<any>('floor_elements', job.site_id,
    'id, table_name, table_number, capacity, section, archived_at, metadata, external_source, external_id');
  const porExterno = new Map<string, any>();
  for (const f of existentes) {
    if (f.external_source === 'clover' && f.external_id) porExterno.set(String(f.external_id), f);
  }

  let creadas = 0, actualizadas = 0, saltadas = 0, archivadas = 0, reactivadas = 0;
  const presentes = new Set<string>();

  for (const m of mesas) {
    presentes.add(m.id);
    const prev = porExterno.get(m.id);
    const meta: Record<string, any> = {
      ...(prev?.metadata ?? {}),
      clover_raw: m.crudo,
      clover_synced_at: new Date().toISOString(),
    };

    if (!prev) {
      // NACE ARCHIVADA (ver la nota de arriba).
      const { error } = await supabase.from('floor_elements').insert({
        site_id: job.site_id, floor_plan_id: planId, type: 'table', shape: 'rect',
        x: 0, y: 0, width: 60, height: 60, rotation: 0, z_index: 0,
        table_name: m.nombre, table_number: m.nombre, capacity: m.asientos,
        section: m.seccionNombre, status: 'available',
        // NACE NO PUBLICABLE. La columna tiene `DEFAULT true`, así que sin esta línea una mesa
        // importada se publicaría sola en la web de reservas en cuanto alguien la desarchive para
        // usarla en el POS. Omnivore tiene una migración dedicada exactamente a esto
        // (`20260821153826_omnivore_floor_sync_imports_not_bookable.sql`). Sólo en el INSERT: a
        // quien ya publicó una mesa a mano no se le toca.
        bookable_online: false,
        external_source: 'clover', external_id: m.id,
        archived_at: new Date().toISOString(),
        metadata: { ...meta, archived_reason: 'import', clover_baseline: { table_name: m.nombre } },
      });
      if (error) throw error;
      creadas++;
      continue;
    }

    // REACTIVACIÓN: la mesa había desaparecido de Clover y ha vuelto. Se le quita la marca de
    // muerta, igual que hace Omnivore (`sync_omnivore_floor_tables`: `v_meta - 'omnivore_deleted_at'`
    // con su contador `v_reactivated`). Sin esto seguiría oculta del plano para siempre.
    const estabaMuerta = prev.metadata?.clover_deleted_at != null;
    if (estabaMuerta) { delete meta.clover_deleted_at; reactivadas++; }

    // Override local del nombre: si difiere de lo último que mandó Clover, manda MCM.
    const baseline = prev.metadata?.clover_baseline?.table_name;
    const nombreLocal = String(prev.table_name ?? '');
    const hayOverride = baseline != null ? nombreLocal !== String(baseline) : nombreLocal !== m.nombre;
    const nombreFinal = hayOverride ? prev.table_name : m.nombre;
    meta.clover_baseline = { ...(meta.clover_baseline ?? {}), table_name: m.nombre };
    if (hayOverride) meta.clover_overrides = ['table_name'];
    else delete meta.clover_overrides;

    const cambio = String(prev.table_name ?? '') !== String(nombreFinal ?? '')
      || Number(prev.capacity ?? 0) !== Number(m.asientos ?? 0)
      || String(prev.section ?? '') !== String(m.seccionNombre ?? '')
      || JSON.stringify(prev.metadata?.clover_baseline ?? null) !== JSON.stringify(meta.clover_baseline)
      || JSON.stringify(prev.metadata?.clover_overrides ?? null) !== JSON.stringify(meta.clover_overrides ?? null)
      // La reactivación es un cambio aunque no se mueva ningún otro campo: si no se contase aquí,
      // el `continue` de abajo descartaría el UPDATE y la mesa seguiría marcada como muerta.
      || estabaMuerta;
    if (!cambio) { saltadas++; continue; }

    // OJO: aquí NO van x/y/width/height/rotation/shape/z_index — el layout es de MCM.
    const { error } = await supabase.from('floor_elements')
      .update({ table_name: nombreFinal, capacity: m.asientos, section: m.seccionNombre, metadata: meta })
      .eq('id', prev.id).eq('site_id', job.site_id);        // multi-tenant: SIEMPRE
    if (error) throw error;
    actualizadas++;
  }

  // ── Marcar las que Clover ya no devuelve ──────────────────────────────────────────────────
  //
  // Se usa `metadata.clover_deleted_at` y se DEJA `archived_at` en NULL, espejando a Omnivore
  // (`metadata.omnivore_deleted_at`). No es un capricho de nomenclatura: escribir `archived_at`
  // metía la mesa en la MISMA barra que lo archivado a mano, donde es arrastrable — y al devolverla
  // al plano el RPC `set_floor_element_archived` limpia `archived_at`, así que el ciclo siguiente
  // la volvía a archivar. Bucle silencioso, sin aviso. Con marca propia, quien la borró en el POS
  // manda, la mesa cae en su grupo de sólo lectura, y no hay nada que arrastrar.
  const candidatas = [...porExterno.entries()]
    .filter(([cid, f]) => !presentes.has(cid) && f.metadata?.clover_deleted_at == null);
  if (candidatas.length > 0) {
    if (!archivarEsSeguro(completo, presentes.size, porExterno.size, candidatas.length)) {
      logger.warn({ site_id: job.site_id, presentes: presentes.size, existentes: porExterno.size,
        candidatas: candidatas.length, completo }, 'clover_tables_archive_skipped_suspicious');
    } else {
      // Una mesa con orden VIVA no se archiva aunque Clover ya no la devuelva: dejaría el cheque
      // abierto colgando de una mesa invisible.
      const ids = candidatas.map(([, f]) => f.id);
      const { data: ocupadas } = await supabase.from('orders')
        .select('table_id').eq('site_id', job.site_id)
        .in('status', ['new-order', 'in-kitchen', 'ready-for-pickup'])
        .in('table_id', ids);
      const conOrden = new Set((ocupadas ?? []).map((o: any) => String(o.table_id)));
      for (const [, f] of candidatas) {
        if (conOrden.has(String(f.id))) { saltadas++; continue; }
        const { error } = await supabase.from('floor_elements')
          .update({ metadata: { ...(f.metadata ?? {}), clover_deleted_at: new Date().toISOString() } })
          .eq('id', f.id).eq('site_id', job.site_id);        // multi-tenant: SIEMPRE
        if (error) throw error;
        archivadas++;
      }
    }
  }

  const resultado = {
    tables_fetched: mesas.length, sections: secciones.length, complete: completo,
    created: creadas, updated: actualizadas, skipped: saltadas, archived: archivadas,
    reactivated: reactivadas,
    duration_ms: Date.now() - inicio,
  };
  logger.info({ site_id: job.site_id, ...resultado }, 'clover fetch_tables completed');

  if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  return resultado as unknown as Record<string, unknown>;
});
