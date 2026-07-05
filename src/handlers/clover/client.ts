import axios, { AxiosInstance } from 'axios';
import { z } from 'zod';
import { resolveCloverBaseUrl } from './region';

export const CloverConfigSchema = z.object({
  apiKey: z.string().min(1),
  merchantId: z.string().min(1),
  apiUrl: z.string().optional(),
  // ADDITIVE (clover-bidi): optional region hint used only when apiUrl is absent.
  region: z.string().optional(),
  sync_orders: z.boolean().default(false),
  injectOrderInStatusChange: z.boolean().optional(),
  statusChangeToTriggerInjectOrder: z.string().optional(),
  standardProductsCategories: z.array(z.string()).optional(),
  defaultEmployeeId: z.string().optional(),
  defaultOrderTypeId: z.string().optional(),
  defaultRevenueCenterId: z.string().optional(),
  // ADDITIVE (clover-bidi): per-tenant catalog-sync feature flags (default OFF via consumers).
  sync_employees: z.boolean().optional(),
  sync_tables: z.boolean().optional(),
  sync_products: z.boolean().optional(),
  sync_modifiers: z.boolean().optional(),
  sync_item_stock: z.boolean().optional(),
  cloverCatalogSyncIntervalSeconds: z.number().optional(),
  // ADDITIVE (clover-bidi): auto-maintain a POS catalog so synced products render in /pos-order.
  autoManageCloverCatalog: z.boolean().optional(),
  cloverCatalogChannels: z.array(z.string()).optional(),
  // ADDITIVE (clover-bidi): attach native catalog modifiers to pushed line items (else note fallback).
  cloverNativeModifiers: z.boolean().optional(),
});

export type CloverConfig = z.infer<typeof CloverConfigSchema>;

export function createCloverClient(
  config: CloverConfig,
  correlationId: string
): AxiosInstance {
  // Backward-compatible: resolveCloverBaseUrl returns config.apiUrl verbatim when set
  // (every existing config sets it), else maps config.region, else the same US default.
  const baseUrl = resolveCloverBaseUrl(config);
  return axios.create({
    baseURL: `${baseUrl}/v3/merchants/${config.merchantId}`,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      // Clover requires a User-Agent on every request (the legacy edge omitted it).
      'User-Agent': 'MyCloudMenu-JobEngine/1.0',
      'X-Correlation-Id': correlationId,
    },
    timeout: 20_000,
  });
}
