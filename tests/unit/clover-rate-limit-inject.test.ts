import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * El token bucket de Clover existía sólo en el bucle de paginación del CATÁLOGO
 * (`catalog-sync.ts`). La INYECCIÓN —`create_order`, `reconcile_items`, `payment_injection`,
 * `create_supplemental_order`— y los pulls de órdenes/pagos no pasaban por él: un solo
 * `reconcile_items` puede disparar `1 GET + N DELETE + ceil(M/100) POST + K POST de
 * modificaciones + 1 POST de total`, y con varios jobs en paralelo son cientos de llamadas en
 * ráfaga contra Clover sin ningún freno.
 *
 * Ahora el límite vive en el interceptor de peticiones del cliente axios, así que lo cubre todo.
 * Estos tests prueban justamente eso: que CUALQUIER llamada hecha con el cliente toma un token.
 */

const h = vi.hoisted(() => ({ tokens: [] as number[] }));

vi.mock('../../src/handlers/clover/sync/rate-limit', () => ({
  acquireCloverToken: vi.fn(async (siteId: number) => { h.tokens.push(siteId); }),
  acquireCloverCatalogToken: vi.fn(async (siteId: number) => { h.tokens.push(siteId); }),
  _resetCloverCatalogBucket: vi.fn(),
}));

import { createCloverClient } from '../../src/handlers/clover/client';

const cfg = { apiKey: 'k', merchantId: 'M', apiUrl: 'https://sandbox.dev.clover.com', sync_orders: true } as any;
beforeEach(() => { h.tokens = []; });

/** Intercepta la petición justo antes de salir a la red: no hace falta servidor. */
function clienteQueNoSale(siteId: number) {
  const c = createCloverClient(cfg, 'corr', siteId);
  c.defaults.adapter = (async (config: any) => ({
    data: {}, status: 200, statusText: 'OK', headers: {}, config,
  })) as any;
  return c;
}

describe('rate limit del cliente de Clover (defecto 1.4)', () => {
  it('un GET toma un token del site', async () => {
    await clienteQueNoSale(99990004).get('/orders/X');
    expect(h.tokens).toEqual([99990004]);
  });

  it('un POST de inyección también lo toma', async () => {
    await clienteQueNoSale(99990004).post('/orders/X/line_items', { name: 'a', price: 1 });
    expect(h.tokens).toEqual([99990004]);
  });

  it('CADA llamada toma su token — una ráfaga de 25 toma 25', async () => {
    const c = clienteQueNoSale(99990004);
    await Promise.all(Array.from({ length: 25 }, (_, i) => c.post(`/orders/X/line_items/${i}`, {})));
    expect(h.tokens).toHaveLength(25);
    expect(h.tokens.every(s => s === 99990004)).toBe(true);
  });

  it('el bucket es POR SITE: dos sites no comparten cuota', async () => {
    await clienteQueNoSale(11111111).get('/items');
    await clienteQueNoSale(22222222).get('/items');
    expect(h.tokens).toEqual([11111111, 22222222]);
  });
});

describe('absorción del 429 en el cliente', () => {
  const e429 = (retryAfter?: string) => Object.assign(new Error('429'), {
    response: { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} },
  });

  /** Cliente cuyo adaptador falla con 429 las `n` primeras veces y luego responde 200. */
  function clienteQueFalla(n: number, retryAfter?: string) {
    const c = createCloverClient(cfg, 'corr', 99990004);
    let intentos = 0;
    c.defaults.adapter = (async (config: any) => {
      intentos++;
      if (intentos <= n) throw Object.assign(e429(retryAfter), { config });
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
    }) as any;
    return { c, cuenta: () => intentos };
  }

  it('un 429 puntual se reintenta solo y la llamada acaba bien', async () => {
    const { c, cuenta } = clienteQueFalla(1);
    const r = await c.get('/items');
    expect((r as any).data).toEqual({ ok: true });
    expect(cuenta()).toBe(2);
  });

  it('reintenta varias veces y acaba resolviendo', async () => {
    const { c, cuenta } = clienteQueFalla(3);
    await c.post('/orders', {});
    expect(cuenta()).toBe(4);
  });

  // El backoff acumulado de un 429 permanente es ~0,5+1+2+4 = 7,5 s antes de rendirse; a partir
  // de ahí toma el relevo el reintento del propio job. De ahí el timeout ampliado.
  it('con 429 permanente deja de insistir y el error sube al handler', async () => {
    const { c, cuenta } = clienteQueFalla(99);
    await expect(c.get('/items')).rejects.toBeTruthy();
    expect(cuenta()).toBeLessThanOrEqual(6);   // 1 + MAX_REINTENTOS_429, con margen
  }, 20_000);

  it('respeta la cabecera Retry-After', async () => {
    const { c } = clienteQueFalla(1, '1');
    const t0 = Date.now();
    await c.get('/items');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('un error que NO es 429 sube tal cual, sin reintentos', async () => {
    const c = createCloverClient(cfg, 'corr', 99990004);
    let intentos = 0;
    c.defaults.adapter = (async (config: any) => {
      intentos++;
      throw Object.assign(new Error('500'), { response: { status: 500, headers: {} }, config });
    }) as any;
    await expect(c.get('/items')).rejects.toBeTruthy();
    expect(intentos).toBe(1);
  });
});
