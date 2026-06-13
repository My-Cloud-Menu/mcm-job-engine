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
 * Recurring Omnivore → MCM sync (replaces the legacy `sync-orders` poll AND the
 * `receive-omnivore-order-webhook`). Fetches today's tickets (open AND closed,
 * PR UTC-4 window) so closes are captured without the webhook, converts and
 * upserts them deduped on `omnivore_pos_id`. Scheduled by `claim_due_schedules`
 * via the `sync_schedules` row (integration='omnivore', sync_type=
 * 'fetch_recent_orders'); leader election prevents double runs.
 */
registerHandler('omnivore', 'fetch_recent_orders', async ({ stepInput, job }) => {
  const input = InputSchema.parse(stepInput);

  const { config } = await getSiteIntegrationConfig(job.site_id, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, job.correlation_id);

  // Timestamp del SNAPSHOT (antes del fetch) — guard de frescura del merge managed:
  // si un fire/void/open outbound ocurre DESPUÉS de esto, el merge salta esa orden.
  const fetchStartIso = new Date().toISOString();

  let orders: any[];
  try {
    // WS-5/F17 (auditoría 2026-06-09): ventana rodante 36h (opened_at) + TODOS los
    // tickets abiertos (sin importar fecha), deduplicados por id. Captura el cierre de
    // mesas que cruzan medianoche y mesas abiertas más viejas que 36h.
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
    'omnivore fetch_recent_orders completed'
  );

  await supabase.rpc('complete_sync_schedule', {
    p_schedule_id: input.schedule_id,
    p_cursor: null,
  });

  return { orders_fetched: orders.length, inserted, updated, skipped };
});
