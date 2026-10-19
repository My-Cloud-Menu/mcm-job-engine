import { z } from 'zod';
import { registerHandler } from '../../registry';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../client';
import { supabase } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';
import { HandlerError } from '../../../core/types';
import { mapOmnivoreError } from '../error-map';
import { connectionsForRequest, forEachConnection, loadOmnivoreConnections, requestedIntegrationId } from '../connections';
import { fetchOmnivoreOosItems, fetchOmnivoreOosModifiers } from './inventory/menu-fetch';
import { readAllBySite } from './inventory/supabase-read';
import { applyLocationStock, desiredOutOfStock, omnivoreIdMap } from './inventory/location-stock';

const InputSchema = z.object({
  schedule_id: z.string().uuid().nullable().optional(),
  manual: z.boolean().optional(),
  integration_id: z.string().uuid().nullable().optional(),
});

const STOCK_TIMEOUT_MS = 120_000;

/**
 * C3 + C6 (Misión Omnivore Multisucursal) · Agotados de Aloha por sucursal, cada 5 minutos.
 * Solo en negocios con conexiones por sucursal (lo programa `fetch_health`/`fetch_products` cuando alguna inyecta). Un
 * negocio de una sola conexión sigue con `products.stock_status` desde el sync de catálogo, como siempre: aquí no hace
 * nada. Cada sucursal en paralelo (8, 2 min cada una); una caída no frena a las demás. Si fallan todas, el job falla y
 * se reintenta.
 */
registerHandler('omnivore', 'fetch_stock', async ({ stepInput, jobPayload, job }) => {
  const input = InputSchema.parse(stepInput);
  const set = await loadOmnivoreConnections(job.site_id);

  const complete = async () => {
    if (input.schedule_id) await supabase.rpc('complete_sync_schedule', { p_schedule_id: input.schedule_id, p_cursor: null });
  };

  if (!set.multi) {
    await complete();
    return { skipped: 'single_connection' };
  }

  const targets = connectionsForRequest(set, requestedIntegrationId(jobPayload as Record<string, unknown>, stepInput as Record<string, unknown>));
  const [products, ingredients] = await Promise.all([
    readAllBySite('products', job.site_id, 'id, additional_properties'),
    readAllBySite('ingredients', job.site_id, 'id, additional_properties'),
  ]);
  const productIds = omnivoreIdMap(products);
  const ingredientIds = omnivoreIdMap(ingredients);

  const results = await forEachConnection(
    targets,
    async (conn) => {
      const client = createOmnivoreClient(OmnivoreConfigSchema.parse(conn.config), job.correlation_id);
      let items, modifiers;
      try {
        [items, modifiers] = await Promise.all([fetchOmnivoreOosItems(client), fetchOmnivoreOosModifiers(client)]);
      } catch (err) {
        throw mapOmnivoreError(err, 'OMNIVORE_FETCH_STOCK_FAILED');
      }
      const { desired, unmapped } = desiredOutOfStock(items, modifiers, productIds, ingredientIds);
      const applied = await applyLocationStock(job.site_id, Number(conn.locationId), desired);
      return { location_id: conn.locationId, out_of_stock: desired.size, unmapped, ...applied };
    },
    { concurrency: 8, timeoutMs: STOCK_TIMEOUT_MS }
  );

  const failed = results.flatMap((r) => (r.ok ? [] : [r]));
  for (const f of failed) {
    logger.warn({ site_id: job.site_id, location_id: f.connection.locationId, err: String((f.error as Error)?.message ?? f.error) }, 'omnivore fetch_stock: connection failed');
  }
  if (results.length > 0 && failed.length === results.length) {
    const err = failed[0]!.error;
    throw err instanceof HandlerError
      ? err
      : new HandlerError(`fetch_stock failed for every connection: ${String((err as Error)?.message ?? err)}`, 'OMNIVORE_FETCH_STOCK_FAILED', true);
  }

  const summary = results.flatMap((r) => (r.ok ? [r.value] : []));
  logger.info({ site_id: job.site_id, connections: results.length, failed: failed.length, summary }, 'omnivore fetch_stock completed');
  await complete();
  return { connections: results.length, failed: failed.length, locations: summary };
});
