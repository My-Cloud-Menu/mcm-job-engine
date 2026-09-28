import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks: el cliente supabase y la config se reemplazan para ver QUÉ RPC llama el worker.
const { rpc, worker } = vi.hoisted(() => ({
  rpc: vi.fn(),
  worker: {
    id: 'w-test',
    queueName: 'billing',
    lockSeconds: 60,
    integrations: null as string[] | null,
    siteIds: null as number[] | null,
  },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/config', () => ({ config: { worker } }));

import { claimNextJob } from '../../src/core/claim';
import { parseSiteIds } from '../../src/lib/parse-site-ids';

describe('parseSiteIds', () => {
  it('parsea la lista y rechaza valores no numéricos', () => {
    expect(parseSiteIds(undefined)).toBeNull();
    expect(parseSiteIds('')).toBeNull();
    expect(parseSiteIds(' 70100000 , 123 ')).toEqual([70100000, 123]);
    expect(() => parseSiteIds('70100000,abc')).toThrow(/WORKER_SITE_IDS/);
  });
});

describe('claimNextJob', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: [], error: null });
  });

  it('sin WORKER_SITE_IDS llama a claim_next_job con los mismos parámetros de siempre', async () => {
    worker.siteIds = null;
    await claimNextJob();
    expect(rpc).toHaveBeenCalledWith('claim_next_job', {
      p_worker_id: 'w-test', p_queue_name: 'billing', p_lock_seconds: 60, p_integrations: null,
    });
  });

  it('con WORKER_SITE_IDS llama a claim_next_job_for_sites con p_site_ids', async () => {
    worker.siteIds = [70100000];
    await claimNextJob();
    expect(rpc).toHaveBeenCalledWith('claim_next_job_for_sites', {
      p_worker_id: 'w-test', p_queue_name: 'billing', p_lock_seconds: 60, p_integrations: null, p_site_ids: [70100000],
    });
  });

  it('devuelve null cuando no hay job y el primer row cuando hay', async () => {
    worker.siteIds = [70100000];
    expect(await claimNextJob()).toBeNull();
    rpc.mockResolvedValueOnce({ data: [{ id: 'j1', site_id: 70100000 }], error: null });
    expect(await claimNextJob()).toEqual({ id: 'j1', site_id: 70100000 });
  });

  it('propaga el error con el nombre de la RPC usada', async () => {
    worker.siteIds = [70100000];
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(claimNextJob()).rejects.toThrow('claim_next_job_for_sites RPC failed: boom');
  });
});
