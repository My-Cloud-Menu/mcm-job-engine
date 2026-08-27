import { supabase } from './supabase';
import { logger } from './logger';

/**
 * Resuelve la sucursal (`locations.id`) a la que debe colgar lo que un sync importa para un site.
 *
 * POR QUÉ EXISTE — el mismo bug lo tuvo Omnivore y se arregló el 2026-07-11
 * (`20260711000200_omnivore_n12_floor_location_and_rc_move.sql`): un `floor_plans` con
 * `location_id` NULL es **intermitente**, no invisible. `lib/supabase/floor.ts` filtra con
 * `.eq('location_id', …)` estricto, así que el plano se ve mientras nadie haya elegido sucursal
 * (el dueño, o cualquiera con `all_locations`) y **desaparece en cuanto alguien la elige** — y esa
 * elección persiste en `localStorage`. Afecta a la vez al editor de plano, al POS
 * (`PosFloorScreen` usa el mismo hook) y a las reservas, que con planos NULL devuelven CERO mesas
 * para una sucursal concreta. Order & Pay no filtra, así que el mesero acaba viendo mesas que el
 * POS no ve.
 *
 * El criterio es **el mismo, verbatim**, que el del RPC vivo `sync_omnivore_floor_tables`:
 *
 *     ORDER BY is_default DESC, is_central ASC, date_created ASC, id ASC   LIMIT 1
 *
 * `is_default` primero; luego la que NO es central (una sucursal que vende antes que un almacén);
 * luego la más antigua; y el id como desempate, para que sea determinista.
 *
 * NO consulta `site_integrations.location_id` a propósito. Ese campo existe y su semántica está
 * documentada, pero el único escenario que lo justificaría —dos integraciones del mismo proveedor
 * activas en dos sucursales— hoy revienta mucho antes: `getSiteIntegrationConfig` usa
 * `.maybeSingle()`, así que ese site no tendría ningún job funcionando. Añadirlo daría una falsa
 * sensación de soporte multi-sucursal.
 *
 * Devuelve `null` cuando el site no tiene ninguna location. Es un resultado LEGÍTIMO, no un error:
 * sin sucursales el selector nunca tiene nada seleccionado y el filtro nunca se activa. No se
 * fabrica una location.
 */
export async function resolveSiteLocationId(siteId: number): Promise<number | null> {
  const { data, error } = await supabase
    .from('locations')
    .select('id')
    .eq('site_id', siteId)                 // multi-tenant: SIEMPRE
    .order('is_default', { ascending: false })
    .order('is_central', { ascending: true })
    .order('date_created', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    // No es fatal: un plano sin sucursal se comporta como hoy y se puede corregir a mano. Pero se
    // deja constancia, porque el síntoma (mesas que van y vienen) no apunta a esto ni de lejos.
    logger.warn({ site_id: siteId, error: error.message }, 'no se pudo resolver la location del site');
    return null;
  }
  return (data as { id: number } | null)?.id ?? null;
}
