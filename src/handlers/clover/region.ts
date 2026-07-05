/**
 * Clover regional base-URL resolution (ADDITIVE).
 *
 * Clover REST hosts are region-scoped and NOT programmatically discoverable, so the region
 * is resolved per-tenant from the integration `config`:
 *   1. `config.apiUrl` (explicit) always wins — this preserves the EXACT prior behavior of
 *      `createCloverClient` for every existing production config (all of which set apiUrl).
 *   2. else `config.region` (new, optional) maps to the canonical host.
 *   3. else the default US host (unchanged default).
 *
 * Verified hosts (Clover docs 2026-07-02 + Fase 0 sandbox smoke):
 *   US/NA   https://api.clover.com          EU      https://api.eu.clover.com
 *   LATAM   https://api.la.clover.com        sandbox https://sandbox.dev.clover.com
 *   (https://apisandbox.dev.clover.com also authenticates in sandbox — both work.)
 */

export const DEFAULT_CLOVER_BASE_URL = 'https://api.clover.com';

/** Canonical region → REST base URL. Keys are lowercased. */
export const CLOVER_REGION_HOSTS: Record<string, string> = {
  us: 'https://api.clover.com',
  na: 'https://api.clover.com',
  north_america: 'https://api.clover.com',
  eu: 'https://api.eu.clover.com',
  europe: 'https://api.eu.clover.com',
  la: 'https://api.la.clover.com',
  latam: 'https://api.la.clover.com',
  latin_america: 'https://api.la.clover.com',
  sandbox: 'https://sandbox.dev.clover.com',
  dev: 'https://sandbox.dev.clover.com',
  apisandbox: 'https://apisandbox.dev.clover.com',
};

/**
 * Resolve the Clover REST base URL for a tenant config. Backward-compatible:
 * a config with a non-empty `apiUrl` returns that verbatim (identical to the previous
 * `config.apiUrl ?? DEFAULT` behavior for every real config).
 */
export function resolveCloverBaseUrl(config: { apiUrl?: string; region?: string }): string {
  const explicit = (config.apiUrl ?? '').trim();
  if (explicit) return config.apiUrl as string; // verbatim — exact prior behavior

  const region = (config.region ?? '').trim().toLowerCase();
  if (region && CLOVER_REGION_HOSTS[region]) return CLOVER_REGION_HOSTS[region];

  return DEFAULT_CLOVER_BASE_URL;
}
