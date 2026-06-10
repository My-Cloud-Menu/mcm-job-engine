import axios, { AxiosInstance } from 'axios';
import { z } from 'zod';

export const CloverConfigSchema = z.object({
  apiKey: z.string().min(1),
  merchantId: z.string().min(1),
  apiUrl: z.string().optional(),
  sync_orders: z.boolean().default(false),
  injectOrderInStatusChange: z.boolean().optional(),
  statusChangeToTriggerInjectOrder: z.string().optional(),
  standardProductsCategories: z.array(z.string()).optional(),
  defaultEmployeeId: z.string().optional(),
  defaultOrderTypeId: z.string().optional(),
  defaultRevenueCenterId: z.string().optional(),
});

export type CloverConfig = z.infer<typeof CloverConfigSchema>;

export function createCloverClient(
  config: CloverConfig,
  correlationId: string
): AxiosInstance {
  const baseUrl = config.apiUrl ?? 'https://api.clover.com';
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
