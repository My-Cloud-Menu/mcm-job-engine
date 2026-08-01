import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * 2026-08-01 — el push del cierre automático dejó de estrangular al pull.
 *
 * El claim (`auto_settle_claim_due`) lo comparten el push (este handler) y el pull (heartbeat del
 * terminal), y bloquea 10 min. Reclamar antes de saber si el terminal responde hacía que un push roto
 * se comiera el turno de la única vía que de verdad cierra el lote cuando el terminal pasa la noche
 * apagado. Aquí se fija el contrato nuevo:
 *   • terminal con `op_last_seen_at` viejo → NO se reclama (queda libre para el pull);
 *   • dispatch fallido → se libera el claim (`last_try_at = null`);
 *   • un 404 de la edge se reporta como `http_404: …`, no como si el terminal no hubiera contestado.
 */

vi.mock('../../src/config', () => ({
  config: {
    supabase: { url: 'http://edge.test', serviceRoleKey: 'srk-test' },
    autoSettle: { onlineWindowMin: 10 },
  },
}));
vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn() }) },
}));

type Harness = {
  due: string[];
  dueError: any;
  devices: Array<{ id: string; op_last_seen_at: string | null }>;
  devicesError: any;
  configs: Array<{ device_id: string; last_error: string | null; attempt_count: number | null }>;
  claims: Record<string, boolean>;
  rpcCalls: Array<{ fn: string; args: any }>;
  updates: Array<{ patch: any; filters: Record<string, any> }>;
};

const h: Harness = {
  due: [],
  dueError: null,
  devices: [],
  devicesError: null,
  configs: [],
  claims: {},
  rpcCalls: [],
  updates: [],
};

vi.mock('../../src/lib/supabase', () => {
  const selectChain = (table: string) => {
    const filters: Record<string, any> = {};
    const c: any = {
      eq: (k: string, v: any) => { filters[k] = v; return c; },
      in: (k: string, v: any) => { filters[k] = v; return c; },
      then: (resolve: any) => {
        if (table === 'devices') return resolve({ data: h.devices, error: h.devicesError });
        return resolve({ data: h.configs, error: null });
      },
    };
    return c;
  };
  const updateChain = (patch: any) => {
    const filters: Record<string, any> = {};
    const c: any = {
      eq: (k: string, v: any) => { filters[k] = v; return c; },
      then: (resolve: any) => { h.updates.push({ patch, filters }); return resolve({ error: null }); },
    };
    return c;
  };
  return {
    supabase: {
      from: (table: string) => ({
        select: () => selectChain(table),
        update: (patch: any) => updateChain(patch),
      }),
      rpc: async (fn: string, args: any) => {
        h.rpcCalls.push({ fn, args });
        if (fn === 'auto_settle_due_for_site') {
          return { data: h.due.map((id) => ({ device_id: id })), error: h.dueError };
        }
        if (fn === 'auto_settle_claim_due') {
          return { data: h.claims[args.p_device_id] ?? false, error: null };
        }
        return { data: null, error: null };
      },
    },
  };
});

import '../../src/handlers/auto-settle/dispatch';
import { partitionByFreshness, SETTLE_STATE_OFFLINE, SETTLE_STATE_OVERDUE } from '../../src/handlers/auto-settle/dispatch';
import { getHandler } from '../../src/handlers/registry';

const handler = getHandler('auto_settle', 'auto_settle_dispatch')!;
const SITE = 51021421;

function run() {
  return handler({
    stepInput: {},
    jobPayload: {},
    context: {},
    job: { id: 'job-1', site_id: SITE } as any,
    step: {} as any,
  });
}

function mockFetch(impl: () => Promise<any>) {
  // @ts-expect-error test stub
  global.fetch = vi.fn(impl);
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeEach(() => {
  h.due = [];
  h.dueError = null;
  h.devices = [];
  h.devicesError = null;
  h.configs = [];
  h.claims = {};
  h.rpcCalls = [];
  h.updates = [];
  mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ result: 'success' }) }));
});

describe('partitionByFreshness', () => {
  it('separa el terminal que late del que lleva horas apagado', () => {
    const r = partitionByFreshness(
      ['vivo', 'apagado', 'nunca-visto'],
      { vivo: ago(2), apagado: ago(12 * 60), 'nunca-visto': null },
      Date.now(),
      10,
    );
    expect(r.fresh).toEqual(['vivo']);
    expect(r.stale).toEqual(['apagado', 'nunca-visto']);
  });

  it('el borde de la ventana cuenta como vivo', () => {
    const now = Date.now();
    const r = partitionByFreshness(['borde'], { borde: new Date(now - 10 * 60_000).toISOString() }, now, 10);
    expect(r.fresh).toEqual(['borde']);
  });

  it('una fecha corrupta se trata como apagado, no revienta', () => {
    const r = partitionByFreshness(['x'], { x: 'no-es-una-fecha' }, Date.now(), 10);
    expect(r.stale).toEqual(['x']);
  });
});

describe('auto_settle_dispatch handler', () => {
  it('handler está registrado', () => {
    expect(typeof handler).toBe('function');
  });

  it('NO reclama terminales apagados: sin claim, el pull queda libre', async () => {
    h.due = ['OP-APAGADO'];
    h.devices = [{ id: 'OP-APAGADO', op_last_seen_at: ago(12 * 60) }];
    h.configs = [{ device_id: 'OP-APAGADO', last_error: 'Requested function was not found', attempt_count: 15 }];

    const out: any = await run();

    expect(h.rpcCalls.find((c) => c.fn === 'auto_settle_claim_due')).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(out).toMatchObject({ candidates: 1, claimed: 0, failed: 0, skipped_offline: 1 });
  });

  it('auto-limpia el error pegado del terminal apagado con el estado informativo', async () => {
    h.due = ['OP-APAGADO'];
    h.devices = [{ id: 'OP-APAGADO', op_last_seen_at: ago(12 * 60) }];
    h.configs = [{ device_id: 'OP-APAGADO', last_error: 'Requested function was not found', attempt_count: 15 }];

    await run();

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.patch).toEqual({ last_error: SETTLE_STATE_OFFLINE });
    expect(h.updates[0]!.filters).toMatchObject({ device_id: 'OP-APAGADO', site_id: SITE });
  });

  it('no reescribe el estado si ya es el correcto (un write por cambio, no uno por barrido)', async () => {
    h.due = ['OP-APAGADO'];
    h.devices = [{ id: 'OP-APAGADO', op_last_seen_at: ago(12 * 60) }];
    h.configs = [{ device_id: 'OP-APAGADO', last_error: SETTLE_STATE_OFFLINE, attempt_count: 15 }];

    await run();

    expect(h.updates).toHaveLength(0);
  });

  it('al terminal vivo sí le reclama y le despacha', async () => {
    h.due = ['OP-VIVO'];
    h.devices = [{ id: 'OP-VIVO', op_last_seen_at: ago(1) }];
    h.configs = [{ device_id: 'OP-VIVO', last_error: null, attempt_count: 0 }];
    h.claims['OP-VIVO'] = true;

    const out: any = await run();

    expect(h.rpcCalls.some((c) => c.fn === 'auto_settle_claim_due' && c.args.p_device_id === 'OP-VIVO')).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ claimed: 1, settled: 1, failed: 0, skipped_offline: 0 });
  });

  it('dispatch fallido LIBERA el claim para que el pull pueda reclamar', async () => {
    h.due = ['OP-VIVO'];
    h.devices = [{ id: 'OP-VIVO', op_last_seen_at: ago(1) }];
    h.configs = [{ device_id: 'OP-VIVO', last_error: null, attempt_count: 0 }];
    h.claims['OP-VIVO'] = true;
    mockFetch(async () => ({ ok: false, status: 404, json: async () => ({ message: 'Requested function was not found' }) }));

    const out: any = await run();

    const release = h.updates.find((u) => 'last_try_at' in u.patch);
    expect(release).toBeDefined();
    expect(release!.patch.last_try_at).toBeNull();
    expect(out).toMatchObject({ claimed: 1, settled: 0, failed: 1 });
  });

  it('un 404 se reporta como fallo de infraestructura, no como "el terminal no contestó"', async () => {
    h.due = ['OP-VIVO'];
    h.devices = [{ id: 'OP-VIVO', op_last_seen_at: ago(1) }];
    h.configs = [{ device_id: 'OP-VIVO', last_error: null, attempt_count: 0 }];
    h.claims['OP-VIVO'] = true;
    mockFetch(async () => ({ ok: false, status: 404, json: async () => ({ message: 'Requested function was not found' }) }));

    await run();

    const release = h.updates.find((u) => 'last_try_at' in u.patch)!;
    expect(release.patch.last_error).toBe('http_404: Requested function was not found');
  });

  it('un 200 que no trae result:success sigue contando como fallo', async () => {
    h.due = ['OP-VIVO'];
    h.devices = [{ id: 'OP-VIVO', op_last_seen_at: ago(1) }];
    h.configs = [{ device_id: 'OP-VIVO', last_error: null, attempt_count: 0 }];
    h.claims['OP-VIVO'] = true;
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ message: '⏱️ Timeout esperando respuesta' }) }));

    const out: any = await run();

    expect(out).toMatchObject({ failed: 1, settled: 0 });
    const release = h.updates.find((u) => 'last_try_at' in u.patch)!;
    expect(release.patch.last_error).toBe('⏱️ Timeout esperando respuesta');
  });

  it('terminal en línea con varios turnos sin cerrar → marca el fallo silencioso del pull', async () => {
    h.due = ['OP-VIVO'];
    h.devices = [{ id: 'OP-VIVO', op_last_seen_at: ago(1) }];
    h.configs = [{ device_id: 'OP-VIVO', last_error: null, attempt_count: 3 }];
    h.claims['OP-VIVO'] = false; // el turno lo tiene el pull; aun así el barrido deja constancia

    await run();

    expect(h.updates.some((u) => u.patch.last_error === SETTLE_STATE_OVERDUE)).toBe(true);
  });

  it('si la RPC de candidatos falla, el step falla en vez de reportar candidates:0', async () => {
    h.dueError = { message: 'boom' };
    await expect(run()).rejects.toThrow(/auto_settle_due_for_site failed/);
  });

  it('si no se puede leer devices, no se reclama a ciegas', async () => {
    h.due = ['OP-VIVO'];
    h.devicesError = { message: 'timeout' };
    await expect(run()).rejects.toThrow(/devices lookup failed/);
    expect(h.rpcCalls.find((c) => c.fn === 'auto_settle_claim_due')).toBeUndefined();
  });

  it('sin candidatos no toca nada y cierra el schedule', async () => {
    const out: any = await run();
    expect(out).toMatchObject({ candidates: 0, claimed: 0, skipped_offline: 0 });
    expect(h.updates).toHaveLength(0);
  });
});
