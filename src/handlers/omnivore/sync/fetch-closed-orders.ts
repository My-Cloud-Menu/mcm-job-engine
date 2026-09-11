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
 * CARRIL LENTO (90s) del sync Omnivore → MCM. Dos pases deduplicados por id de ticket:
 * los CERRADOS recientemente (`'closed'`, por `closed_at`) + TODOS los abiertos (`'open'`,
 * sin cota de tiempo).
 *
 * Su trabajo es detectar los CIERRES sin depender del webhook de Omnivore: un ticket que se
 * cerró aparece en el pase `'closed'` con `open=false` y el mapper lo pasa a
 * check-closed/fulfilled. El pase `'open'` mantiene frescas las mesas que siguen abiertas,
 * por viejas que sean.
 *
 * 2026-09-11: el primer pase era `'today'` —ventana de 24h sobre `opened_at`—, lo que obligaba
 * a traer todo lo abierto en el último día para ver los cierres del último minuto (2.915
 * tickets / 159s en 70080000). Al filtrar por `closed_at` la ventana deja de depender de
 * cuánto dure la mesa abierta y baja a 2h. Ojo: con ello un ticket que se cierra mientras el
 * worker lleva más de 2h caído ya no se recupera — ver la nota en `order-mapper.ts`.
 *
 * El carril rápido (`fetch_open_orders`, 20s) es un subconjunto estricto del pase `'open'`,
 * así que este barrido no puede perder nada que aquél viera.
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
    // Cerrados en las últimas CLOSED_LOOKBACK_HOURS (por `closed_at`) + TODOS los tickets
    // abiertos (sin importar fecha), deduplicados por id. El cierre de una mesa que cruza
    // medianoche o que llevaba días abierta entra por el primer pase, porque lo que se mira
    // es cuándo cerró.
    const [recent, open] = await Promise.all([
      fetchOmnivoreOrders(client, 'closed'),
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
