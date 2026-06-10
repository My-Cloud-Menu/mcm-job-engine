import { supabase } from './supabase';
import { HandlerError } from '../core/types';

interface CachedConfig {
  config: Record<string, unknown>;
  integrationId: string;
  expiresAt: number;
}

interface IntegrationConfig {
  config: Record<string, unknown>;
  integrationId: string;
}

const cache = new Map<string, CachedConfig>();
const TTL_MS = 60_000;

/**
 * Fetch and cache the active integration config for a site+provider pair.
 * Cached for 60 seconds to avoid repeated DB lookups per job step.
 *
 * `type` narrows the lookup (e.g. 'pos') for parity with the legacy
 * `getCredentials` in mcm-edge-functions, which filters `type='pos' AND
 * provider='omnivore'` so a site can hold several integrations of the same
 * provider without colliding. Omitting `type` preserves the prior behaviour.
 */
export async function getSiteIntegrationConfig(
  siteId: number,
  provider: string,
  type?: string
): Promise<IntegrationConfig> {
  const key = `${siteId}:${provider}:${type ?? ''}`;
  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return { config: cached.config, integrationId: cached.integrationId };
  }

  let query = supabase
    .from('site_integrations')
    .select('id, config')
    .eq('site_id', siteId)
    .eq('provider', provider)
    .eq('active', true);

  if (type) query = query.eq('type', type);

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new HandlerError(
      `Failed to fetch integration config: ${error.message}`,
      'INTEGRATION_LOOKUP_FAILED',
      true
    );
  }

  if (!data) {
    throw new HandlerError(
      `No active integration found for site ${siteId}, provider ${provider}`,
      'NO_INTEGRATION',
      false // Not retryable — requires customer action
    );
  }

  const entry: CachedConfig = {
    config: data.config as Record<string, unknown>,
    integrationId: data.id as string,
    expiresAt: Date.now() + TTL_MS,
  };

  cache.set(key, entry);
  return { config: entry.config, integrationId: entry.integrationId };
}

export function invalidateCredentialsCache(siteId?: number, provider?: string) {
  if (siteId !== undefined && provider !== undefined) {
    const prefix = `${siteId}:${provider}:`;
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
  } else {
    cache.clear();
  }
}
