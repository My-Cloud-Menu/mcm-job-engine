import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapCloverError } from '../error-map';
import { readAllBySite } from '../../omnivore/sync/inventory/supabase-read';
import { fetchCloverTablesAndSections, MesaClover } from './table-mapper';

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

  // El plano: uno por site para las mesas de Clover. Se crea sólo si hay algo que colocar.
  let planId: string | null = null;
  {
    const { data } = await supabase.from('floor_plans').select('id')
      .eq('site_id', job.site_id).eq('external_source', 'clover').maybeSingle();
    planId = (data as any)?.id ?? null;
    if (!planId && mesas.length > 0) {
      const { data: nuevo, error } = await supabase.from('floor_plans')
        .insert({ site_id: job.site_id, name: 'Clover', is_active: true, external_source: 'clover', external_id: cloverConfig.merchantId })
        .select('id').single();
      if (error) throw error;
      planId = (nuevo as any).id;
    }
  }

  const existentes = await readAllBySite<any>('floor_elements', job.site_id,
    'id, table_name, table_number, capacity, section, archived_at, metadata, external_source, external_id');
  const porExterno = new Map<string, any>();
  for (const f of existentes) {
    if (f.external_source === 'clover' && f.external_id) porExterno.set(String(f.external_id), f);
  }

  let creadas = 0, actualizadas = 0, saltadas = 0, archivadas = 0;
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
        external_source: 'clover', external_id: m.id,
        archived_at: new Date().toISOString(),
        metadata: { ...meta, archived_reason: 'import', clover_baseline: { table_name: m.nombre } },
      });
      if (error) throw error;
      creadas++;
      continue;
    }

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
      || JSON.stringify(prev.metadata?.clover_overrides ?? null) !== JSON.stringify(meta.clover_overrides ?? null);
    if (!cambio) { saltadas++; continue; }

    // OJO: aquí NO van x/y/width/height/rotation/shape/z_index — el layout es de MCM.
    const { error } = await supabase.from('floor_elements')
      .update({ table_name: nombreFinal, capacity: m.asientos, section: m.seccionNombre, metadata: meta })
      .eq('id', prev.id).eq('site_id', job.site_id);        // multi-tenant: SIEMPRE
    if (error) throw error;
    actualizadas++;
  }

  // ── Archivar las que Clover ya no devuelve ────────────────────────────────────────────────
  const candidatas = [...porExterno.entries()].filter(([cid, f]) => !presentes.has(cid) && !f.archived_at);
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
          .update({ archived_at: new Date().toISOString(),
            metadata: { ...(f.metadata ?? {}), archived_reason: 'clover_removed' } })
          .eq('id', f.id).eq('site_id', job.site_id);
        if (error) throw error;
        archivadas++;
      }
    }
  }

  const resultado = {
    tables_fetched: mesas.length, sections: secciones.length, complete: completo,
    created: creadas, updated: actualizadas, skipped: saltadas, archived: archivadas,
    duration_ms: Date.now() - inicio,
  };
  logger.info({ site_id: job.site_id, ...resultado }, 'clover fetch_tables completed');

  if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  return resultado as unknown as Record<string, unknown>;
});
