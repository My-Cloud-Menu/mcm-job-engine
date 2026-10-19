import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { pickConnection, IntegrationRow } from '../../src/lib/credentials';
import {
  buildConnectionSet,
  catalogSourceConnection,
  connectionInjects,
  connectionsForRequest,
  forEachConnection,
  requestedIntegrationId,
} from '../../src/handlers/omnivore/connections';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'fixtures/omnivore-site-integrations.json'), 'utf8')
) as { rows: Array<IntegrationRow & { site_id: number }> };

const row = (id: string, location_id: number | null, active: boolean, config: Record<string, unknown>): IntegrationRow => ({ id, location_id, active, config });

describe('buildConnectionSet (K2)', () => {
  it('negocios vivos (filas reales): una sola conexión, la MISMA que resolvía el worker antes', () => {
    const sites = [...new Set(fixture.rows.filter((r) => r.active).map((r) => r.site_id))];
    expect(sites.length).toBeGreaterThanOrEqual(5);
    for (const site of sites) {
      const rows = fixture.rows.filter((r) => r.site_id === site);
      const set = buildConnectionSet(rows, site);
      expect(set.multi).toBe(false);
      expect(set.connections).toHaveLength(1);
      expect(set.connections[0]).toEqual(pickConnection(rows, site, 'omnivore'));
    }
  });

  it('Chili’s (solo fila de sucursal INACTIVA): sin conexión activa → mismo error de siempre', () => {
    const rows = fixture.rows.filter((r) => r.site_id === 72110000);
    expect(() => buildConnectionSet(rows, 72110000)).toThrow(/No active integration/);
  });

  it('varias sucursales: una conexión por sucursal activa, config efectiva y orden por sucursal', () => {
    const rows = [
      row('biz', null, true, { apiKey: 'K', omnivoreId: '', defaultEmployeeId: '100', sendOrderToOmnivoreInStatusChange: true }),
      row('l3', 71000003, true, { omnivoreId: 'L3', defaultEmployeeId: '' }),
      row('l1', 71000001, true, { omnivoreId: 'L1', defaultEmployeeId: '7' }),
      row('l2', 71000002, false, { omnivoreId: 'L2' }),
    ];
    const set = buildConnectionSet(rows, 71000000);
    expect(set.multi).toBe(true);
    expect(set.connections.map((c) => c.integrationId)).toEqual(['l1', 'l3']);
    expect(set.connections[0]!.config).toMatchObject({ apiKey: 'K', omnivoreId: 'L1', defaultEmployeeId: '7' });
    expect(set.connections[1]!.config).toMatchObject({ apiKey: 'K', omnivoreId: 'L3', defaultEmployeeId: '100' });
    expect(set.business?.integrationId).toBe('biz');
  });

  it('solo filas de sucursal (sin fila del negocio): cada una tal cual', () => {
    const set = buildConnectionSet([row('l1', 1, true, { apiKey: 'A', omnivoreId: 'X' })], 9);
    expect(set.multi).toBe(true);
    expect(set.business).toBeNull();
    expect(set.connections[0]!.config).toEqual({ apiKey: 'A', omnivoreId: 'X' });
  });
});

describe('catalogSourceConnection (C2)', () => {
  const rows = [
    row('biz', null, true, { apiKey: 'K' }),
    row('l1', 1, true, { omnivoreId: 'A' }),
    row('l2', 2, true, { omnivoreId: 'B' }),
    row('l3', 3, true, { omnivoreId: 'C' }),
  ];
  it('la sucursal elegida en la config del negocio', () => {
    const set = buildConnectionSet([{ ...rows[0]!, config: { apiKey: 'K', catalogSourceLocationId: '3' } }, ...rows.slice(1)], 9);
    expect(catalogSourceConnection(set, '2').integrationId).toBe('l3');
  });
  it('sin elegir (o elegida sin conexión activa) → la sucursal principal', () => {
    expect(catalogSourceConnection(buildConnectionSet(rows, 9), '2').integrationId).toBe('l2');
    const set = buildConnectionSet([{ ...rows[0]!, config: { apiKey: 'K', catalogSourceLocationId: 99 } }, ...rows.slice(1)], 9);
    expect(catalogSourceConnection(set, 2).integrationId).toBe('l2');
  });
  it('sin principal con conexión → la primera por sucursal', () => {
    expect(catalogSourceConnection(buildConnectionSet(rows, 9), null).integrationId).toBe('l1');
    expect(catalogSourceConnection(buildConnectionSet(rows, 9), '42').integrationId).toBe('l1');
  });
  it('una sola conexión → esa', () => {
    const set = buildConnectionSet([row('only', null, true, { apiKey: 'K', omnivoreId: 'Z' })], 9);
    expect(catalogSourceConnection(set, '1').integrationId).toBe('only');
  });
});

describe('connectionsForRequest / requestedIntegrationId (U2)', () => {
  const set = buildConnectionSet([row('l1', 1, true, { apiKey: 'K', omnivoreId: 'A' }), row('l2', 2, true, { apiKey: 'K', omnivoreId: 'B' })], 9);
  it('sin id: todas; con id propio: esa; con id ajeno: error sin reintento', () => {
    expect(connectionsForRequest(set, null)).toHaveLength(2);
    expect(connectionsForRequest(set, 'l2').map((c) => c.integrationId)).toEqual(['l2']);
    expect(() => connectionsForRequest(set, 'otro')).toThrow(expect.objectContaining({ code: 'NO_INTEGRATION', retryable: false }));
  });
  it('el id viene en la entrada del paso o en el payload', () => {
    expect(requestedIntegrationId({ integration_id: 'p' }, {})).toBe('p');
    expect(requestedIntegrationId({}, { integration_id: 's' })).toBe('s');
    expect(requestedIntegrationId({ integration_id: '' }, {})).toBeNull();
  });
});

describe('connectionInjects (mismo && que la edge)', () => {
  it('inyecta solo con la bandera verdadera y un estado disparador', () => {
    expect(connectionInjects({ sendOrderToOmnivoreInStatusChange: true, statusChangeToTriggerOmnivoreOrder: 'in-kitchen' })).toBe(true);
    expect(connectionInjects({ sendOrderToOmnivoreInStatusChange: false, statusChangeToTriggerOmnivoreOrder: 'in-kitchen' })).toBe(false);
    expect(connectionInjects({ sendOrderToOmnivoreInStatusChange: true, statusChangeToTriggerOmnivoreOrder: '' })).toBe(false);
    for (const r of fixture.rows.filter((x) => x.active)) expect(connectionInjects(r.config ?? {})).toBe(false); // ningún vivo inyecta
  });
});

describe('forEachConnection', () => {
  const conns = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ integrationId: id, locationId: String(i + 1), config: {} }));
  it('respeta el tope de concurrencia y conserva el orden', async () => {
    let inFlight = 0;
    let peak = 0;
    const res = await forEachConnection(conns, async (c) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return c.integrationId.toUpperCase();
    }, { concurrency: 2 });
    expect(peak).toBe(2);
    expect(res.map((r) => (r.ok ? r.value : null))).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
  it('una sucursal lenta o caída no frena ni tumba a las demás', async () => {
    const res = await forEachConnection(conns.slice(0, 3), async (c) => {
      if (c.integrationId === 'a') await new Promise((r) => setTimeout(r, 200));
      if (c.integrationId === 'b') throw new Error('Aloha caído');
      return 'ok';
    }, { concurrency: 3, timeoutMs: 50 });
    expect(res[0]).toMatchObject({ ok: false, error: expect.objectContaining({ code: 'CONNECTION_TIMEOUT' }) });
    expect(res[1]).toMatchObject({ ok: false });
    expect(res[2]).toMatchObject({ ok: true, value: 'ok' });
  });
});
