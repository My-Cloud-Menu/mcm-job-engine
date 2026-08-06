import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: {
    alerts: {
      rateLimitPerHour: 20,          // carril warning/info
      rateLimitCriticalPerHour: 60,  // carril critical
      rateLimitPerSitePerHour: 6,    // techo por site (sólo warning/info)
    },
  },
}));

/**
 * Constructor de un query builder falso de supabase-js. Devuelve `{ count, error }` al await,
 * y guarda los filtros aplicados para que el test pueda distinguir la consulta global
 * (sin `site_id`) de la consulta por site.
 */
type Filters = Array<[string, unknown]>;
let respond: (filters: Filters) => { count: number | null; error: unknown };

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const filters: Filters = [];
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        gte: chain,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        neq: (col: string, val: unknown) => {
          filters.push([`neq:${col}`, val]);
          return q;
        },
        insert: () => Promise.resolve({ error: null }),
        then: (resolve: (r: unknown) => unknown) => resolve(respond(filters)),
      });
      return q;
    },
  },
}));

const { canSend } = await import('../../src/observability/alerts/rate-limiter');

const isPerSiteQuery = (filters: Filters) => filters.some(([col]) => col === 'site_id');

describe('alert rate limiter — carriles separados', () => {
  beforeEach(() => {
    respond = () => ({ count: 0, error: null });
  });

  it('un critical NO se suprime por el ruido de warning/info', async () => {
    // 25 envíos no-críticos en la hora: por encima del cupo global de 20.
    respond = () => ({ count: 25, error: null });

    expect((await canSend('a@b.com', 'warning', 51021421)).allowed).toBe(false);
    // El critical cuenta contra SU carril (60), que sigue con holgura.
    expect((await canSend('a@b.com', 'critical', 99990003)).allowed).toBe(true);
  });

  it('warning se bloquea al agotar el cupo global, con motivo "global"', async () => {
    respond = filters => (isPerSiteQuery(filters) ? { count: 0, error: null } : { count: 20, error: null });

    const verdict = await canSend('a@b.com', 'warning', 51021421);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('global');
  });

  it('un site ruidoso se autolimita sin agotar el cupo global', async () => {
    // Global holgado (3 de 20), pero ese site ya lleva 6 — su techo.
    respond = filters => (isPerSiteQuery(filters) ? { count: 6, error: null } : { count: 3, error: null });

    const ruidoso = await canSend('a@b.com', 'warning', 25612612);
    expect(ruidoso.allowed).toBe(false);
    expect(ruidoso.reason).toBe('per_site');

    // Otro site distinto, con el mismo cupo global, sí pasa: el ruido no lo tapa.
    respond = filters => (isPerSiteQuery(filters) ? { count: 0, error: null } : { count: 3, error: null });
    expect((await canSend('a@b.com', 'warning', 51021421)).allowed).toBe(true);
  });

  it('el techo por site NO aplica a critical', async () => {
    respond = filters => (isPerSiteQuery(filters) ? { count: 99, error: null } : { count: 1, error: null });

    expect((await canSend('a@b.com', 'critical', 25612612)).allowed).toBe(true);
  });

  it('las alertas globales (site_id null) se saltan el techo por site', async () => {
    respond = () => ({ count: 3, error: null });

    expect((await canSend('a@b.com', 'warning', null)).allowed).toBe(true);
  });

  it('falla ABIERTO si la DB da error — mejor un email de más que perder el aviso', async () => {
    respond = () => ({ count: null, error: new Error('boom') });

    expect((await canSend('a@b.com', 'warning', 51021421)).allowed).toBe(true);
  });
});
