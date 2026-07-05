import { describe, it, expect } from 'vitest';
import { resolveCloverBaseUrl, DEFAULT_CLOVER_BASE_URL } from '../../src/handlers/clover/region';
import { CloverConfigSchema } from '../../src/handlers/clover/client';

describe('resolveCloverBaseUrl (additive region resolution)', () => {
  it('explicit apiUrl wins verbatim — exact prior behavior (prod-shaped config)', () => {
    expect(resolveCloverBaseUrl({ apiUrl: 'https://sandbox.dev.clover.com' })).toBe('https://sandbox.dev.clover.com');
    expect(resolveCloverBaseUrl({ apiUrl: 'https://api.clover.com' })).toBe('https://api.clover.com');
  });

  it('apiUrl wins even when region is also present', () => {
    expect(resolveCloverBaseUrl({ apiUrl: 'https://api.eu.clover.com', region: 'us' })).toBe('https://api.eu.clover.com');
  });

  it('maps region when apiUrl is absent', () => {
    expect(resolveCloverBaseUrl({ region: 'eu' })).toBe('https://api.eu.clover.com');
    expect(resolveCloverBaseUrl({ region: 'latam' })).toBe('https://api.la.clover.com');
    expect(resolveCloverBaseUrl({ region: 'la' })).toBe('https://api.la.clover.com');
    expect(resolveCloverBaseUrl({ region: 'sandbox' })).toBe('https://sandbox.dev.clover.com');
    expect(resolveCloverBaseUrl({ region: 'US' })).toBe('https://api.clover.com'); // case-insensitive
  });

  it('defaults to US host when neither apiUrl nor region is set (unchanged default)', () => {
    expect(resolveCloverBaseUrl({})).toBe(DEFAULT_CLOVER_BASE_URL);
    expect(DEFAULT_CLOVER_BASE_URL).toBe('https://api.clover.com');
  });

  it('unknown region falls back to the default host', () => {
    expect(resolveCloverBaseUrl({ region: 'mars' })).toBe(DEFAULT_CLOVER_BASE_URL);
  });
});

describe('CloverConfigSchema (G3: additive optional fields, non-strict)', () => {
  it('parses a production-shaped config (no new fields) without error', () => {
    const prod = {
      apiKey: 'x'.repeat(36),
      merchantId: '7ES0TRRRYJCY1',
      apiUrl: 'https://sandbox.dev.clover.com',
      sync_orders: true,
      injectOrderInStatusChange: true,
      statusChangeToTriggerInjectOrder: 'in-kitchen',
      standardProductsCategories: [],
      defaultTenderId: '4QPPVE0NFNBN4', // unknown-to-schema key present in real config
    };
    const parsed = CloverConfigSchema.parse(prod);
    expect(parsed.merchantId).toBe('7ES0TRRRYJCY1');
    expect(parsed.apiUrl).toBe('https://sandbox.dev.clover.com');
  });

  it('accepts the new optional catalog-sync flags', () => {
    const parsed = CloverConfigSchema.parse({
      apiKey: 'k', merchantId: 'm', region: 'eu',
      sync_employees: true, sync_products: true, sync_modifiers: false,
      sync_item_stock: true, sync_tables: false, cloverCatalogSyncIntervalSeconds: 3600,
    });
    expect(parsed.region).toBe('eu');
    expect(parsed.sync_employees).toBe(true);
  });
});
