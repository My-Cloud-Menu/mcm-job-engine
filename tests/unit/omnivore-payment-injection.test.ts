import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  existingPosId: null as string | null,
  existingAdditionalProps: null as Record<string, unknown> | null,
  paymentUpdates: [] as any[],
}));

vi.mock('../../src/handlers/omnivore/client', () => ({
  createOmnivoreClient: () => ({ post: h.post, get: h.get }),
  OmnivoreConfigSchema: { parse: (c: unknown) => c },
}));
vi.mock('../../src/lib/credentials', () => ({
  getSiteIntegrationConfig: vi.fn(async () => ({ config: { apiKey: 'k', omnivoreId: 'L' }, integrationId: 'i' })),
}));
vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn() }) },
}));
// Builder encadenable genérico: cualquier secuencia de filtros (.eq/.neq/.not/.lt/…) devuelve
// el mismo builder, y el resultado se obtiene con await, .maybeSingle() o .single(). Modela el
// PostgREST real lo bastante como para cubrir todas las queries del handler y de sus helpers
// (`readOmnivoreApplied`, `writeOmnivoreApplied`, `reconcileOrderIssues`, la escalada de
// `job_steps.max_attempts`) sin tener que enumerar cada cadena a mano.
const FILTER_OPS = ['eq', 'neq', 'not', 'lt', 'lte', 'gt', 'gte', 'is', 'in', 'order', 'limit', 'select'];

function makeChain(result: any) {
  const builder: any = {
    maybeSingle: async () => result,
    single: async () => result,
    then: (onOk: any, onErr: any) => Promise.resolve(result).then(onOk, onErr),
  };
  for (const op of FILTER_OPS) builder[op] = () => builder;
  return builder;
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () =>
        makeChain(
          table === 'payments'
            ? { data: { pos_id: h.existingPosId, additional_properties: h.existingAdditionalProps }, error: null }
            : // `integration_jobs` → reconcileOrderIssues busca hermanos pendientes: ninguno.
              { data: [], error: null }
        ),
      update: (patch: any) => {
        h.paymentUpdates.push({ table, patch });
        return makeChain({ data: [{ id: 'x' }], error: null });
      },
    }),
  },
}));

import '../../src/handlers/omnivore/inject/payment';
import { getHandler } from '../../src/handlers/registry';

const handler = getHandler('omnivore', 'payment_injection')!;
const job = { id: 'job-1', site_id: 25, correlation_id: 'c' } as any;
const step = { idempotency_key: 'pos_pay:omnivore:55:apply', attempt_count: 0, max_attempts: 5 } as any;
const payment = { type: '3rd_party', tender_type: '102', tip: 0, amount: 2000, comment: 'Invoice #: 7' };

function run() {
  return handler({
    stepInput: {},
    jobPayload: { payment_id: 55, order_id: 123, ticket_id: 'TICKET-9', payment },
    context: {},
    job,
    step,
  });
}

describe('omnivore payment_injection handler', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.get.mockReset();
    h.existingPosId = null;
    h.existingAdditionalProps = null;
    h.paymentUpdates.length = 0;
  });

  it('applies the payment and persists payments.pos_id', async () => {
    h.post.mockResolvedValue({ data: { id: 'OMNI-PAY-1' } });

    const out = await run();

    expect(out).toMatchObject({ omnivore_payment_id: 'OMNI-PAY-1' });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-9/payments', payment, expect.anything());
    const upd = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.pos_id === 'OMNI-PAY-1');
    expect(upd).toBeTruthy();
  });

  it('skips when the MCM payment already has a pos_id (resume guard)', async () => {
    h.existingPosId = 'ALREADY';

    const out = await run();

    expect(out).toMatchObject({ skipped: 'already_applied', omnivore_payment_id: 'ALREADY' });
    expect(h.post).not.toHaveBeenCalled();
  });

  // Clover-pull forward: pos_id holds the CLOVER payment id, so the marker must
  // be read/written under additional_properties.omnivore_payment_id instead.
  function runWithMarker() {
    return handler({
      stepInput: {},
      jobPayload: {
        payment_id: 55,
        order_id: 123,
        ticket_id: 'TICKET-9',
        payment,
        pos_id_field: 'additional_properties.omnivore_payment_id',
      },
      context: {},
      job,
      step,
    });
  }

  it('marker mode: ignores pos_id (Clover id), applies, and writes additional_properties marker', async () => {
    h.existingPosId = 'CLOVER-PAY'; // must NOT count as applied-to-Omnivore
    h.existingAdditionalProps = {};
    h.post.mockResolvedValue({ data: { id: 'OMNI-PAY-2' } });

    const out = await runWithMarker();

    expect(out).toMatchObject({ omnivore_payment_id: 'OMNI-PAY-2' });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-9/payments', payment, expect.anything());
    const upd = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.additional_properties);
    expect(upd.patch.additional_properties).toMatchObject({ omnivore_payment_id: 'OMNI-PAY-2' });
    // Must NOT have written pos_id (that belongs to Clover here).
    expect(h.paymentUpdates.find((u) => u.patch.pos_id)).toBeUndefined();
  });

  it('marker mode: skips when the additional_properties marker is already set (resume guard)', async () => {
    h.existingAdditionalProps = { omnivore_payment_id: 'ALREADY-OMNI' };

    const out = await runWithMarker();

    expect(out).toMatchObject({ skipped: 'already_applied', omnivore_payment_id: 'ALREADY-OMNI' });
    expect(h.post).not.toHaveBeenCalled();
  });

  // ── Contención: el mesero tiene el ticket abierto en el terminal ───────────────
  // Omnivore responde `ticket_locked`, que `error-map.ts` clasifica como error de NEGOCIO
  // (no-retryable). Para ESTE handler standalone lo tratamos como contención y reintentamos.

  /** Error tal como lo devuelve Omnivore: slug en el body, con HTTP no-5xx. */
  const omnivoreError = (slug: string, status = 400) =>
    Object.assign(new Error('Request failed with status code ' + status), {
      isAxiosError: true,
      response: { status, data: { errors: [{ error: slug, description: `${slug} description` }] } },
    });

  /** Step fresco por test: el handler MUTA `max_attempts`, así que no puede compartirse. */
  const freshStep = () => ({ id: 'step-1', idempotency_key: 'k', attempt_count: 0, max_attempts: 5 }) as any;

  function runWithStep(s: any) {
    return handler({
      stepInput: {},
      jobPayload: { payment_id: 55, order_id: 123, ticket_id: 'TICKET-9', payment },
      context: {},
      job,
      step: s,
    });
  }

  it('ticket_locked: se vuelve retryable, sube el techo del step a 31 y espacia ~60s', async () => {
    h.post.mockRejectedValue(omnivoreError('ticket_locked'));
    const s = freshStep();

    const err: any = await runWithStep(s).then(
      () => { throw new Error('debió lanzar'); },
      (e) => e
    );

    expect(err.code).toBe('OMNIVORE_TICKET_LOCKED');
    expect(err.retryable).toBe(true);
    // Ritmo plano de 60s ±10% de jitter — mantiene 1 fallo/min, lejos del umbral del breaker.
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(54);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(66);

    // Techo elevado en memoria (lo lee el executor en esta misma pasada) y persistido.
    expect(s.max_attempts).toBe(31);
    const stepUpdate = h.paymentUpdates.find((u) => u.table === 'job_steps');
    expect(stepUpdate.patch).toMatchObject({ max_attempts: 31 });
  });

  it('ticket_locked: marca orders.issues desde el PRIMER fallo, sin esperar a agotarse', async () => {
    h.post.mockRejectedValue(omnivoreError('ticket_locked'));
    const s = freshStep();

    await runWithStep(s).catch(() => {});

    const issueUpdate = h.paymentUpdates.find((u) => u.table === 'orders' && u.patch.issues);
    expect(issueUpdate).toBeTruthy();
    expect(issueUpdate.patch.issues.friendly_error).toContain('ticket_locked');
  });

  it('ticket_locked: no vuelve a subir el techo si el step ya lo tiene', async () => {
    h.post.mockRejectedValue(omnivoreError('ticket_locked'));
    const s = { ...freshStep(), max_attempts: 31 };

    await runWithStep(s).catch(() => {});

    expect(h.paymentUpdates.find((u) => u.table === 'job_steps')).toBeUndefined();
  });

  it('ticket_closed sigue siendo terminal (no se contagia de la excepción de ticket_locked)', async () => {
    h.post.mockRejectedValue(omnivoreError('ticket_closed'));
    const s = freshStep();

    const err: any = await runWithStep(s).then(
      () => { throw new Error('debió lanzar'); },
      (e) => e
    );

    expect(err.code).toBe('OMNIVORE_TICKET_CLOSED');
    expect(err.retryable).toBe(false);
    expect(s.max_attempts).toBe(5);
    expect(h.paymentUpdates.find((u) => u.table === 'job_steps')).toBeUndefined();
  });
});
