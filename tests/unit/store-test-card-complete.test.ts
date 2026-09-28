import { describe, it, expect, vi, beforeEach } from 'vitest';

// La edge se simula: se comprueba QUÉ le pide el handler y cómo trata sus respuestas.
const { callSubsEdge } = vi.hoisted(() => ({ callSubsEdge: vi.fn() }));
vi.mock('../../src/handlers/subs/call-edge', () => ({ callSubsEdge: (...a: unknown[]) => callSubsEdge(...a) }));

import { HandlerError } from '../../src/core/types';
import { getHandler } from '../../src/handlers/registry';
import '../../src/handlers/store/test-card-complete';

const run = (payload: unknown) => getHandler('store', 'test_card_complete')!({ jobPayload: payload } as never);

describe('store.test_card_complete', () => {
  // Con llaves: si el callback DEVUELVE algo (mockReset devuelve el mock), Vitest lo ejecuta como teardown.
  beforeEach(() => { callSubsEdge.mockReset(); });

  it('llama a test-card-confirm en modo interno con el pago del job', async () => {
    callSubsEdge.mockResolvedValue({ status: 'succeeded', delayed: true });
    await expect(run({ site_id: 70100000, payment_id: 10040 })).resolves.toEqual({ status: 'succeeded', delayed: true });
    expect(callSubsEdge).toHaveBeenCalledWith('test-card-confirm', { site_id: 70100000, payment_id: 10040, internal_complete: true });
  });

  it('409 (pago ya movido u orden cancelada) es respuesta firme: no reintenta', async () => {
    const e409 = new HandlerError('test-card-confirm HTTP 409: order_cancelled', 'SUBS_EDGE_HTTP_409', false, 409);
    callSubsEdge.mockImplementation(async () => { throw e409; });
    await expect(run({ site_id: 1, payment_id: 2 })).resolves.toMatchObject({ skipped: 'nothing_to_complete' });
  });

  it('un 5xx se propaga para que el job reintente', async () => {
    const err = new HandlerError('test-card-confirm HTTP 503', 'SUBS_EDGE_HTTP_503', true, 503);
    callSubsEdge.mockImplementation(async () => { throw err; });
    await expect(run({ site_id: 1, payment_id: 2 })).rejects.toBe(err);
  });

  it('payload inválido falla antes de llamar a nada', async () => {
    await expect(run({ site_id: '1' })).rejects.toThrow();
    expect(callSubsEdge).not.toHaveBeenCalled();
  });
});

import '../../src/handlers/store/reconcile-payments';

describe('store.reconcile_payments', () => {
  beforeEach(() => { callSubsEdge.mockReset(); });
  it('pasa sólo el negocio a la edge de conciliación', async () => {
    callSubsEdge.mockResolvedValue({ completed: [], abandoned: [1] });
    const r = await getHandler('store', 'reconcile_payments')!({ jobPayload: { site_id: 70100000 } } as never);
    expect(r).toEqual({ completed: [], abandoned: [1] });
    expect(callSubsEdge).toHaveBeenCalledWith('store-payments-reconcile', { site_id: 70100000 }, 60_000);
  });
});
