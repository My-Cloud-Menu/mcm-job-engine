import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Las llaves de idempotencia DEBEN llevar el `site_id`.
 *
 * `integration_jobs.idempotency_key` es UNIQUE **global**, pero `orders.id` y
 * `payments.id` son secuencias **por sitio** (PK compuesta `(id, site_id)`). Sin el
 * site en la llave, `enqueue_job` —que hace `ON CONFLICT DO NOTHING`— devuelve el job
 * de OTRO tenant y descarta la inyección en silencio: sin error, sin dead-letter y sin
 * alerta. El cheque queda abierto en el POS mientras MCM lo da por cobrado.
 *
 * Ocurrió en vivo el 2026-08-07: el pago 10246 del site 99990003 chocó con un job del
 * site 48372619 creado el 10 de junio, y nunca se aplicó a Aloha.
 *
 * Además el formato debe coincidir **exactamente** con el que produce la edge
 * (`_shared/helpers/omnivore-helper.ts`), porque los dos son productores del mismo job:
 * si divergen, el mismo pago podría encolarse dos veces y cobrarse doble en el POS.
 */

const rpc = vi.fn(async () => ({ data: 'job-uuid', error: null }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { enqueueOrderInjection, enqueuePaymentInjection, enqueueCloverSupplementalInjection } from '../../src/enqueue/helpers';

const argsDe = (n = 0) => rpc.mock.calls[n][1] as Record<string, any>;

beforeEach(() => rpc.mockClear());

describe('llaves de idempotencia · aislamiento multi-tenant', () => {
  it('pos_pay lleva el site y coincide con el formato de la edge', async () => {
    await enqueuePaymentInjection({
      siteId: 99990003, paymentId: 10246, orderId: 10328,
      ticketId: '20260807-10003', posProvider: 'omnivore', payment: {},
    });
    const a = argsDe();
    expect(a.p_idempotency_key).toBe('pos_pay:omnivore:99990003:10246');
    // el step-key hereda la base → hereda el site
    expect(a.p_steps[0].idempotency_key).toBe('pos_pay:omnivore:99990003:10246:apply');
  });

  it('dos sites con el MISMO payment.id producen llaves distintas', async () => {
    const base = { paymentId: 10246, orderId: 1, ticketId: 't', posProvider: 'omnivore' as const, payment: {} };
    await enqueuePaymentInjection({ ...base, siteId: 99990003 });
    await enqueuePaymentInjection({ ...base, siteId: 48372619 });
    expect(argsDe(0).p_idempotency_key).not.toBe(argsDe(1).p_idempotency_key);
  });

  it('pos_inject lleva el site y coincide con el formato de la edge', async () => {
    await enqueueOrderInjection({
      siteId: 99990003, orderId: 10328, posProvider: 'omnivore',
      payload: { order_id: 10328, ticket: {}, items: [], payments: [] },
    });
    const a = argsDe();
    expect(a.p_idempotency_key).toBe('pos_inject:omnivore:99990003:10328');
    expect(a.p_steps.map((s: any) => s.idempotency_key)).toEqual([
      'pos_inject:omnivore:99990003:10328:create_order',
      'pos_inject:omnivore:99990003:10328:add_items',
      'pos_inject:omnivore:99990003:10328:create_payment',
    ]);
  });

  it('dos sites con el MISMO order.id producen llaves distintas', async () => {
    const base = { orderId: 10328, posProvider: 'omnivore' as const, payload: { order_id: 10328, ticket: {}, items: [], payments: [] } };
    await enqueueOrderInjection({ ...base, siteId: 99990003 });
    await enqueueOrderInjection({ ...base, siteId: 48372619 });
    expect(argsDe(0).p_idempotency_key).not.toBe(argsDe(1).p_idempotency_key);
  });

  it('clover_supp_inject lleva el site', async () => {
    await enqueueCloverSupplementalInjection({
      siteId: 99990003, orderId: 10328, externalReferenceId: 'ref',
      deltaSignature: 'abc123', lineItems: [], totalCents: 500,
    });
    const a = argsDe();
    expect(a.p_idempotency_key).toBe('clover_supp_inject:99990003:10328:abc123');
    expect(a.p_steps[0].idempotency_key).toBe('clover_supp_inject:99990003:10328:abc123:create');
  });

  it('el site de la llave siempre coincide con el p_site_id del job', async () => {
    await enqueuePaymentInjection({
      siteId: 55126712, paymentId: 77, orderId: 1, ticketId: 't',
      posProvider: 'omnivore', payment: {},
    });
    const a = argsDe();
    expect(a.p_idempotency_key.split(':')[2]).toBe(String(a.p_site_id));
  });
});
