import { vi, describe, it, expect, beforeEach } from 'vitest';
import fixture from './fixtures/omnivore-site-integrations.json';

const h = vi.hoisted(() => ({ rows: [] as unknown[], error: null as { message: string } | null, filters: [] as unknown[][] }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {};
      b['select'] = () => b;
      b['eq'] = (...a: unknown[]) => {
        h.filters.push(['eq', ...a]);
        return b;
      };
      b['then'] = (resolve: (v: unknown) => unknown) => resolve({ data: h.rows, error: h.error });
      return b;
    },
  },
}));

import {
  pickConnection,
  mergeConnectionConfig,
  getSiteIntegrationConfig,
  invalidateCredentialsCache,
  IntegrationRow,
} from '../../src/lib/credentials';
import { HandlerError } from '../../src/core/types';

const rows = (fixture as { rows: Array<IntegrationRow & { site_id: number }> }).rows;
const VIVOS = [1173690, 51021421, 70080000, 48372619, 25612612];

/** Lo que devolvía la consulta de antes: `.eq(active,true).maybeSingle()` sobre las filas del site. */
function legacyLookup(siteRows: IntegrationRow[]) {
  const active = siteRows.filter((r) => r.active);
  if (active.length !== 1) return null;
  return { config: active[0]!.config, integrationId: active[0]!.id };
}

describe('pickConnection · igualdad con los negocios vivos (filas reales, sin secretos)', () => {
  for (const site of VIVOS) {
    it(`site ${site}: sin alcance y con la sucursal de la orden da EXACTAMENTE la fila de hoy`, () => {
      const siteRows = rows.filter((r) => r.site_id === site);
      const before = legacyLookup(siteRows)!;
      expect(before).not.toBeNull();
      const noScope = pickConnection(siteRows, site, 'omnivore');
      expect(noScope.config).toBe(before.config); // misma referencia: ni copia ni merge
      expect(noScope.integrationId).toBe(before.integrationId);
      expect(noScope.locationId).toBeNull();
      // Negocio sin filas por sucursal: la sucursal de la orden no cambia nada.
      const withLocation = pickConnection(siteRows, site, 'omnivore', { locationId: 90010051 });
      expect(withLocation.config).toBe(before.config);
    });
  }

  it('Chili’s (fila inactiva con sucursal) sigue sin conexión, como hoy', () => {
    const chilis = rows.filter((r) => r.site_id === 72110000);
    expect(chilis.length).toBeGreaterThan(0);
    expect(() => pickConnection(chilis, 72110000, 'omnivore')).toThrowError(/No active integration/);
  });
});

describe('pickConnection · negocio con varias sucursales', () => {
  const business: IntegrationRow = {
    id: 'biz',
    active: true,
    location_id: null,
    config: { apiKey: 'k', defaultTenderId: '10', orderTypeIdKiosk: '7', sendOrderToOmnivoreInStatusChange: true, omnivoreId: '' },
  };
  const locA: IntegrationRow = { id: 'A', active: true, location_id: '71000001', config: { omnivoreId: 'AAA' } };
  const locB: IntegrationRow = { id: 'B', active: true, location_id: '71000002', config: { omnivoreId: 'BBB', defaultTenderId: '99', orderTypeIdKiosk: '' } };
  const locOff: IntegrationRow = { id: 'OFF', active: false, location_id: '71000003', config: { omnivoreId: 'CCC' } };
  const all = [business, locA, locB, locOff];

  it('la sucursal hereda la config del negocio y pone su omnivoreId', () => {
    const r = pickConnection(all, 1, 'omnivore', { locationId: 71000001 });
    expect(r).toMatchObject({ integrationId: 'A', locationId: '71000001' });
    expect(r.config).toMatchObject({ apiKey: 'k', defaultTenderId: '10', orderTypeIdKiosk: '7', sendOrderToOmnivoreInStatusChange: true, omnivoreId: 'AAA' });
  });

  it('«Ajustes propios»: lo que la sucursal define gana; lo vacío se hereda', () => {
    const r = pickConnection(all, 1, 'omnivore', { locationId: '71000002' });
    expect(r.config).toMatchObject({ omnivoreId: 'BBB', defaultTenderId: '99', orderTypeIdKiosk: '7' });
  });

  it('una sucursal sin conexión activa NUNCA cae al Aloha del negocio ni a otra sucursal (M3)', () => {
    expect(() => pickConnection(all, 1, 'omnivore', { locationId: 71000003 })).toThrowError(HandlerError);
    expect(() => pickConnection(all, 1, 'omnivore', { locationId: 71000009 })).toThrowError(/No active omnivore connection for location/);
    try {
      pickConnection(all, 1, 'omnivore', { locationId: 71000009 });
    } catch (e) {
      expect((e as HandlerError).code).toBe('NO_INTEGRATION_FOR_LOCATION');
      expect((e as HandlerError).retryable).toBe(false);
    }
  });

  it('sello: resuelve la fila exacta aunque se haya desactivado (termina el ticket en el mismo Aloha, M6)', () => {
    const r = pickConnection(all, 1, 'omnivore', { integrationId: 'OFF' });
    expect(r).toMatchObject({ integrationId: 'OFF', locationId: '71000003' });
    expect(r.config).toMatchObject({ omnivoreId: 'CCC', defaultTenderId: '10' });
  });

  it('sin sucursal: la fila del negocio (config compartida), nunca una sucursal al azar', () => {
    expect(pickConnection(all, 1, 'omnivore').integrationId).toBe('biz');
  });

  it('dos filas activas sin fila del negocio y sin sucursal: no adivina', () => {
    expect(() => pickConnection([locA, locB], 1, 'omnivore')).toThrowError(/Ambiguous/);
  });

  it('sello a una fila que no existe: error claro, no reintentable', () => {
    expect(() => pickConnection(all, 1, 'omnivore', { integrationId: 'nope' })).toThrowError(HandlerError);
  });
});

describe('mergeConnectionConfig (pura)', () => {
  it('no muta las entradas y trata "", null, undefined y [] como «heredar»', () => {
    const b = { a: 1, list: ['x'], s: 'base' };
    const l = { a: null, list: [], s: '', n: 0, f: false, extra: 'y' };
    const out = mergeConnectionConfig(b, l);
    expect(out).toEqual({ a: 1, list: ['x'], s: 'base', n: 0, f: false, extra: 'y' });
    expect(b).toEqual({ a: 1, list: ['x'], s: 'base' });
  });
});

describe('getSiteIntegrationConfig', () => {
  beforeEach(() => {
    invalidateCredentialsCache();
    h.rows = [];
    h.error = null;
    h.filters = [];
  });

  it('siempre filtra por site_id, proveedor y tipo', async () => {
    h.rows = rows.filter((r) => r.site_id === 1173690);
    await getSiteIntegrationConfig(1173690, 'omnivore', 'pos');
    expect(h.filters).toEqual([
      ['eq', 'site_id', 1173690],
      ['eq', 'provider', 'omnivore'],
      ['eq', 'type', 'pos'],
    ]);
  });

  it('error de base → reintentable, como antes', async () => {
    h.error = { message: 'boom' };
    await expect(getSiteIntegrationConfig(1, 'omnivore', 'pos')).rejects.toMatchObject({ code: 'INTEGRATION_LOOKUP_FAILED', retryable: true });
  });

  it('`fresh` (inyección) no usa el caché: un reintento ve la config recién corregida', async () => {
    h.rows = [{ id: 'biz', active: true, location_id: null, config: { apiKey: 'mala' } }];
    expect((await getSiteIntegrationConfig(8, 'omnivore', 'pos')).config['apiKey']).toBe('mala');
    h.rows = [{ id: 'biz', active: true, location_id: null, config: { apiKey: 'buena' } }];
    expect((await getSiteIntegrationConfig(8, 'omnivore', 'pos')).config['apiKey']).toBe('mala'); // caché de 60 s
    expect((await getSiteIntegrationConfig(8, 'omnivore', 'pos', undefined, { fresh: true })).config['apiKey']).toBe('buena');
  });

  it('el caché distingue el alcance (sucursal A ≠ sucursal B)', async () => {
    h.rows = [
      { id: 'biz', active: true, location_id: null, config: { apiKey: 'k' } },
      { id: 'A', active: true, location_id: 1, config: { omnivoreId: 'AAA' } },
      { id: 'B', active: true, location_id: 2, config: { omnivoreId: 'BBB' } },
    ];
    const a = await getSiteIntegrationConfig(9, 'omnivore', 'pos', { locationId: 1 });
    const b = await getSiteIntegrationConfig(9, 'omnivore', 'pos', { locationId: 2 });
    expect(a.config['omnivoreId']).toBe('AAA');
    expect(b.config['omnivoreId']).toBe('BBB');
  });
});
