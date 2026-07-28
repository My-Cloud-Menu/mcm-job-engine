import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { mapOmnivoreError } from '../error-map';
import { fetchOmnivoreOrders } from './order-mapper';
import { upsertOmnivoreOrders } from './upsert-orders';

const InputSchema = z.object({
  schedule_id: z.string().uuid(),
  cursor: z.string().nullable().optional(),
});

/**
 * CARRIL RÁPIDO (20s) del sync Omnivore → MCM.
 *
 * Hace UNA sola pasada — `eq(open,true)`, el mismo `where` que ya corre en producción
 * en `orderandpay-login` (vía `syncOmnivoreOrdersIntoMCM(..., onlyOpenOrders=true)`) y
 * en el pase `'open'` del barrido completo. Su razón de existir es la latencia: el
 * barrido completo (`fetch_closed_orders`) trae ~3x más tickets y tarda 45-85s, así que
 * una mesa lista para cobrar tardaba 68-84s en aparecer. Con solo las abiertas el ciclo
 * baja a ~19s (medido: ~8s de API + ~162ms por ticket en el loop de upsert).
 *
 * NO detecta cierres: cuando el ticket se cierra desaparece de `eq(open,true)`. De eso se
 * encarga `fetch_closed_orders` con su ventana `opened_at`. Los dos carriles escriben por
 * el mismo `upsertOmnivoreOrders`, que ya es seguro ante ejecuciones concurrentes (UNIQUE
 * (site_id, omnivore_pos_id) + upsert ignoreDuplicates, freshness guard por
 * `omnivore_synced_at`, CAS sobre `date_updated` y guard `orderHasAppliedPayment`).
 *
 * Schedule: `sync_schedules (integration='omnivore', sync_type='fetch_open_orders', 20s)`.
 */
registerHandler('omnivore', 'fetch_open_orders', async ({ stepInput, job }) => {
  const input = InputSchema.parse(stepInput);

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);

  // Timestamp del SNAPSHOT (antes del fetch) — guard de frescura del merge managed:
  // si un fire/void/open outbound ocurre DESPUÉS de esto, el merge salta esa orden.
  const fetchStartIso = new Date().toISOString();

  let orders: any[];
  try {
    orders = await fetchOmnivoreOrders(client, 'open');
  } catch (err) {
    throw mapOmnivoreError(err, 'OMNIVORE_SYNC_FETCH_FAILED');
  }

  const { inserted, updated, skipped } = await upsertOmnivoreOrders(job.site_id, orders, config, fetchStartIso);

  logger.info(
    { site_id: job.site_id, orders_fetched: orders.length, inserted, updated, skipped },
    'omnivore fetch_open_orders completed'
  );

  await supabase.rpc('complete_sync_schedule', {
    p_schedule_id: input.schedule_id,
    p_cursor: null,
  });

  return { orders_fetched: orders.length, inserted, updated, skipped };
});
