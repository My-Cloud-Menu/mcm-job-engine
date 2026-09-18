import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * D2 (2026-09-18): el job `payment_injection` NO postea el tender mientras la orden gestionada tenga
 * líneas sin `item_id` (nunca llegaron al POS) o un fire en vuelo. Espera (retryable, 15 s) y sube el
 * techo de intentos del step; con todo en el POS, no hace nada.
 */
const h = vi.hoisted(() => ({ order: null as any, updates: [] as any[] }));
vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/lib/credentials', () => ({ getSiteIntegrationConfig: vi.fn() }));
vi.mock('../../src/handlers/omnivore/client', () => ({ createOmnivoreClient: vi.fn(), OmnivoreConfigSchema: { parse: (x: any) => x } }));
vi.mock('../../src/lib/supabase', () => {
  const chain = (val: any) => { const c: any = { eq: () => c, lt: () => c, limit: () => c, maybeSingle: async () => val, single: async () => val, then: (res: any) => res(val) }; return c; };
  return { supabase: { from: (table: string) => ({
    select: () => chain(table === 'orders' ? { data: h.order, error: null } : { data: null, error: null }),
    update: (patch: any) => { h.updates.push({ table, patch }); return chain({ error: null }); },
  }) } };
});

import { assertItemsInPos } from '../../src/handlers/omnivore/inject/payment';

const step = () => ({ id: 's1', max_attempts: 5, attempt_count: 0 } as any);
const managed = (lines: any[], ap: any = {}) => ({ id: 500, line_items: lines, additional_properties: { omnivore_managed: true, ...ap } });
const fired = { id: 'a', status: 'sent', additional_properties: { omnivore: { item_id: '1', origin: 'mcm' } } };
const ghost = { id: 'g', status: null, additional_properties: {} };

describe('assertItemsInPos', () => {
  beforeEach(() => { h.updates.length = 0; });
  it('todo en el POS → no lanza', async () => {
    h.order = managed([fired]);
    await expect(assertItemsInPos(25612612, 500, 9, step())).resolves.toBeUndefined();
  });
  it('línea sin id → lanza retryable con retryAfterSeconds 15 y sube max_attempts a 20', async () => {
    h.order = managed([fired, ghost]);
    const s = step();
    await expect(assertItemsInPos(25612612, 500, 9, s)).rejects.toMatchObject({ code: 'OMNIVORE_ITEMS_NOT_IN_POS', retryable: true, retryAfterSeconds: 15 });
    expect(s.max_attempts).toBe(20);
    expect(h.updates.find((u) => u.table === 'job_steps')?.patch).toEqual({ max_attempts: 20 });
  });
  it('fire en vuelo (aunque todo tenga id) → lanza retryable', async () => {
    h.order = managed([fired], { omnivore_fire: { in_flight_until: new Date(Date.now() + 60_000).toISOString() } });
    await expect(assertItemsInPos(25612612, 500, 9, step())).rejects.toMatchObject({ retryable: true });
  });
  it('orden no gestionada o no encontrada → no lanza', async () => {
    h.order = { id: 500, line_items: [ghost], additional_properties: {} };
    await expect(assertItemsInPos(25612612, 500, 9, step())).resolves.toBeUndefined();
    h.order = null;
    await expect(assertItemsInPos(25612612, 500, 9, step())).resolves.toBeUndefined();
  });
  it('al agotar intentos escribe orders.issues con motivo claro', async () => {
    h.order = managed([ghost]);
    const s = { id: 's1', max_attempts: 20, attempt_count: 19 } as any;
    await expect(assertItemsInPos(25612612, 500, 9, s)).rejects.toMatchObject({ retryable: true });
    const issue = h.updates.find((u) => u.table === 'orders')?.patch?.issues;
    expect(issue?.friendly_error).toContain('items_not_in_pos');
    expect(issue?.payment_id).toBe(9);
  });
});
