import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { buildOrdersUrl, getPageLimit } from './order-mapper';
import { upsertOrdersFromClover } from './upsert-orders';

const InputSchema = z.object({
  schedule_id: z.string().uuid(),
  cursor: z.string().nullable().optional(),
});

// Runs every 25s — fetches all of today's orders (UTC-4) regardless of payment state.
// Keeps the kitchen/floor display up to date in near-real-time.
registerHandler('clover', 'fetch_open_orders', async ({ stepInput, job }) => {
  const input = InputSchema.parse(stepInput);

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover');
  const cloverConfig = CloverConfigSchema.parse(config);

  if (cloverConfig.sync_orders !== true) {
    await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
    return { orders_fetched: 0, skipped_reason: 'sync_orders_disabled' };
  }

  // Instante ANTES de pedirle nada a Clover. El merge gestionado lo usa como guard de
  // frescura: si un push escribió después de este sello, su estado es más nuevo y el pull
  // no lo pisa.
  const fetchStartIso = new Date().toISOString();
  const client = createCloverClient(cloverConfig, job.correlation_id, job.site_id);
  const baseUrl = `${client.defaults.baseURL}`;
  const limit = getPageLimit();
  let offset = 0;
  const allOrders: unknown[] = [];

  while (true) {
    const url = buildOrdersUrl(baseUrl, offset);
    const response = await client.get<{ elements?: unknown[] }>(url);
    const batch = response.data.elements ?? [];
    allOrders.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 150));
  }

  const { inserted, updated, skipped } = await upsertOrdersFromClover(job.site_id, allOrders, {
    tableServiceEnabled: (cloverConfig as any).cloverTableServiceEnabled === true,
    fetchStartIso,
  });

  logger.info(
    { site_id: job.site_id, orders_fetched: allOrders.length, inserted, updated, skipped },
    'clover fetch_open_orders completed'
  );

  await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });

  return { orders_fetched: allOrders.length, inserted, updated, skipped };
});
