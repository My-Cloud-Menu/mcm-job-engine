import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * H-N7 · COBRO DOBLE. Medido contra el merchant sandbox `7ES0TRRRYJCY1`: dos POST idénticos a
 * `/orders/{id}/payments` con la MISMA `Idempotency-Key` crearon **dos pagos de $10** sobre la
 * misma orden (`PAZCB9PCP3V5G` y `53ADEQ3HNQH5G`). Clover **ignora** la cabecera.
 *
 * El comentario del código decía literalmente "re-postea con la MISMA key → Clover deduplica en
 * vez de crear un 2º pago". Es falso, y era la única protección que se creía tener aparte del
 * guard por `payments.pos_id`.
 *
 * El agujero real: si el POST tiene éxito en Clover pero el proceso muere ANTES de escribir
 * `pos_id`, el reintento cobra dos veces. Omnivore ya resuelve esto con
 * *reconcile-before-repost* (`omnivore/inject/payment.ts:176-195`), y su regla más importante es
 * que **si el GET falla, NO postea**.
 *
 * Ancla: `note = mcm:pay:{site}:{payment_id}`. Verificado contra el merchant que `note` sobrevive
 * el viaje de ida y vuelta. No se usa `externalPaymentId` porque la edge lo llena con
 * `Invoice #: …`, que es un valor de presentación y no es único por pago.
 */

const h = vi.hoisted(() => ({
  pagoMcm: null as any,          // fila de `payments`
  pagosEnClover: [] as any[],    // lo que devuelve el GET de la orden
  posts: [] as any[],
  gets: 0,
  getFalla: false,
  updates: [] as any[],
}));

vi.mock('../../src/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/lib/credentials', () => ({
  getSiteIntegrationConfig: vi.fn(async () => ({ config: { apiKey: 'k', merchantId: 'M', apiUrl: 'https://x', sync_orders: true } })),
}));
vi.mock('../../src/handlers/clover/client', async (orig) => {
  const real = await (orig() as any);
  return {
    ...real,
    createCloverClient: vi.fn(() => ({
      get: vi.fn(async () => {
        h.gets++;
        if (h.getFalla) throw Object.assign(new Error('boom'), { response: { status: 500 } });
        return { data: { payments: { elements: h.pagosEnClover } } };
      }),
      post: vi.fn(async (_u: string, body: any) => {
        h.posts.push(body);
        const nuevo = { id: 'CLV_PAY_' + h.posts.length, amount: body.amount, note: body.note };
        h.pagosEnClover.push(nuevo);
        return { data: nuevo };
      }),
    })),
  };
});
vi.mock('../../src/lib/supabase', () => {
  const chain = (row: any) => { const c: any = { eq: () => c, maybeSingle: async () => ({ data: row, error: null }), then: (r: any) => r({ data: row ? [row] : [], error: null }) }; return c; };
  const write = () => { const c: any = { eq: () => c, then: (r: any) => r({ error: null }) }; return c; };
  return { supabase: { from: () => ({
    select: () => chain(h.pagoMcm),
    update: (p: any) => { h.updates.push(p); return write(); },
    upsert: () => ({ then: (r: any) => r({ error: null }) }),
  }) } };
});

import '../../src/handlers/clover/inject/payment';
import { getHandler } from '../../src/handlers/registry';

const correr = (attempt = 0) => getHandler('clover', 'payment_injection')!({
  jobPayload: { ticket_id: 'ORD1', payment_id: 77, order_id: 10, payment: { amount: 1000, tender: { id: 'T' } } },
  context: {}, job: { id: 'j', site_id: 99990004, correlation_id: 'c' } as any,
  step: { idempotency_key: 'k', attempt_count: attempt, max_attempts: 4 } as any,
} as any);

beforeEach(() => { h.pagoMcm = { pos_id: null }; h.pagosEnClover = []; h.posts = []; h.gets = 0; h.getFalla = false; h.updates = []; });

describe('cobro doble en Clover (H-N7)', () => {
  it('el pago lleva el ancla `note` con site y payment_id', async () => {
    await correr(0);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].note).toBe('mcm:pay:99990004:77');
  });

  it('REINTENTO tras un POST que ya aterrizó: NO cobra dos veces, adopta el pago', async () => {
    // el intento 1 aplicó el pago en Clover, pero MCM murió antes de escribir `pos_id`
    h.pagosEnClover = [{ id: 'CLV_PAY_YA', amount: 1000, note: 'mcm:pay:99990004:77' }];
    const r: any = await correr(1);
    expect(h.posts).toHaveLength(0);                       // <- no se re-postea
    expect(r.clover_payment_id).toBe('CLV_PAY_YA');
    expect(r.reconciled).toBe(true);
    expect(h.updates.some(u => u.pos_id === 'CLV_PAY_YA')).toBe(true);
  });

  it('si el GET de reconciliación FALLA, NO postea (regla de Omnivore)', async () => {
    h.getFalla = true;
    await expect(correr(1)).rejects.toThrow();
    expect(h.posts).toHaveLength(0);   // preferible reintentar luego que cobrar dos veces
  });

  it('un pago AJENO del mismo importe no se confunde con el nuestro', async () => {
    h.pagosEnClover = [{ id: 'OTRO', amount: 1000, note: 'mcm:pay:99990004:99' }];
    await correr(1);
    expect(h.posts).toHaveLength(1);   // el nuestro no estaba: sí hay que postear
  });

  it('el primer intento no gasta un GET (el camino normal no paga peaje)', async () => {
    await correr(0);
    expect(h.gets).toBe(0);
  });

  it('el guard por pos_id sigue funcionando', async () => {
    h.pagoMcm = { pos_id: 'YA_APLICADO' };
    const r: any = await correr(0);
    expect(r.skipped).toBe('already_applied');
    expect(h.posts).toHaveLength(0);
  });
});
