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
 * CARRIL LENTO (90s) del sync Omnivore → MCM. Es el BARRIDO COMPLETO: el cuerpo de
 * `fetch_recent_orders` sin cambios (ventana rodante sobre `opened_at` + TODOS los tickets
 * abiertos, deduplicados por id).
 *
 * Su trabajo es detectar los CIERRES sin depender del webhook de Omnivore: la ventana
 * `'today'` trae los tickets del período tanto abiertos como cerrados, así que un ticket
 * que se cerró aparece aquí con `open=false` y el mapper lo pasa a check-closed/fulfilled.
 * El pase `'open'` sin cota se conserva como red de seguridad para las mesas abiertas más
 * viejas que la ventana.
 *
 * El carril rápido (`fetch_open_orders`, 20s) es un subconjunto estricto de esto, así que
 * este barrido no puede perder nada que aquél viera.
 *
 * Schedule: `sync_schedules (integration='omnivore', sync_type='fetch_closed_orders', 90s)`.
 * Reemplaza a `fetch_recent_orders`, cuyo handler se conserva registrado para los jobs en
 * vuelo y para el rollback.
 */
registerHandler('omnivore', 'fetch_closed_orders', async ({ stepInput, job }) => {
  const input = InputSchema.parse(stepInput);

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);

  // Timestamp del SNAPSHOT (antes del fetch) — guard de frescura del merge managed:
  // si un fire/void/open outbound ocurre DESPUÉS de esto, el merge salta esa orden.
  const fetchStartIso = new Date().toISOString();

  let orders: any[];
  try {
    // WS-5/F17 (auditoría 2026-06-09): ventana rodante sobre `opened_at` (hoy 24h) + TODOS
    // los tickets abiertos (sin importar fecha), deduplicados por id. Captura el cierre de
    // mesas que cruzan medianoche y mesas abiertas más viejas que la ventana.
    const [recent, open] = await Promise.all([
      fetchOmnivoreOrders(client, 'today'),
      fetchOmnivoreOrders(client, 'open'),
    ]);
    const byId = new Map<string, any>();
    for (const o of [...recent, ...open]) {
      if (o?.id) byId.set(String(o.id), o);
    }
    orders = [...byId.values()];
  } catch (err) {
    throw mapOmnivoreError(err, 'OMNIVORE_SYNC_FETCH_FAILED');
  }

  const { inserted, updated, skipped } = await upsertOmnivoreOrders(job.site_id, orders, config, fetchStartIso);

  logger.info(
    { site_id: job.site_id, orders_fetched: orders.length, inserted, updated, skipped },
    'omnivore fetch_closed_orders completed'
  );

  await supabase.rpc('complete_sync_schedule', {
    p_schedule_id: input.schedule_id,
    p_cursor: null,
  });

  return { orders_fetched: orders.length, inserted, updated, skipped };
});
