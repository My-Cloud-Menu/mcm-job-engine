import axios, { AxiosInstance } from 'axios';
import { z } from 'zod';

const BASE_URL = 'https://api.omnivore.io/1.0';

/**
 * Mirrors the real `site_integrations.config` shape for provider='omnivore'
 * (camelCase, as written by the dashboard `/integrations` form — see
 * `mcm-dashboard-2.1/types/integrations.ts::OmnivoreConfig`).
 *
 * Only `apiKey` + `omnivoreId` are required to authenticate and address the
 * location. Under the "edge builds, job-engine sends" architecture (Option A),
 * the handlers receive fully pre-built request bodies and only need these two
 * fields; the remaining config keys (tender IDs, default employee/order_type,
 * meta-item IDs, auto_send/auto_close, …) are consumed by the edge payload
 * builder, so we keep them via `.passthrough()` rather than enumerate them.
 */
export const OmnivoreConfigSchema = z
  .object({
    apiKey: z.string().min(1),
    omnivoreId: z.string().min(1),
    isDev: z.boolean().optional(),
  })
  .passthrough();

export type OmnivoreConfig = z.infer<typeof OmnivoreConfigSchema>;

/**
 * Creates an Axios instance pre-configured for the Omnivore API.
 * @param config - Validated Omnivore credentials from `site_integrations.config`
 * @param correlationId - Propagated to X-Correlation-Id header for tracing
 */
export function createOmnivoreClient(
  config: OmnivoreConfig,
  correlationId: string
): AxiosInstance {
  return axios.create({
    baseURL: `${BASE_URL}/locations/${config.omnivoreId}`,
    headers: {
      'Api-Key': config.apiKey,
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId,
    },
    // POS round-trips (Aloha/Micros) can be slow; transient timeouts are
    // classified as retryable by the error-map and handled by backoff.
    timeout: 20_000,
  });
}
