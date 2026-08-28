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

// Runs every 2min — fetches only PAID orders for today (UTC-4).
// Ensures closed orders are finalized and reconciled even if missed by the open-orders handler.
registerHandler('clover', 'fetch_closed_orders', async ({ stepInput, job }) => {
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
    const batch = (response.data.elements ?? []) as any[];
    // Filter client-side: only reconcile PAID orders.
    const paid = batch.filter((o) => o.paymentState === 'PAID');
    allOrders.push(...paid);
    if (batch.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 150));
  }

  const { inserted, updated, skipped } = await upsertOrdersFromClover(job.site_id, allOrders, {
    tableServiceEnabled: (cloverConfig as any).cloverTableServiceEnabled === true,
    fetchStartIso,
    // `rate_code -> id` esta configurado al reves de como se necesita al LEER, asi que se
    // invierte aqui. Sin el, el clasificador de tasas cae al respaldo por nombre.
    taxRateIdToCode: Object.fromEntries(
      Object.entries(((cloverConfig as any).cloverTaxRateIdByRateCode ?? {}) as Record<string, unknown>)
        .filter(([, id]) => typeof id === 'string' && id)
        .map(([rateCode, id]) => [id as string, rateCode]),
    ),
  });

  logger.info(
    { site_id: job.site_id, orders_fetched: allOrders.length, inserted, updated, skipped },
    'clover fetch_closed_orders completed'
  );

  await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });

  return { orders_fetched: allOrders.length, inserted, updated, skipped };
});
