import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  existingPosId: null as string | null,
  existingAdditionalProps: null as Record<string, unknown> | null,
  paymentUpdates: [] as any[],
  inserts: [] as any[],
  /** Simula el 23505 de `payments_site_pos_id_uniq` en el `update({ pos_id })`. */
  posIdUpdateError: null as null | { code: string; message: string },
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
        if (table === 'payments' && patch.pos_id !== undefined && h.posIdUpdateError) {
          return makeChain({ data: null, error: h.posIdUpdateError });
        }
        return makeChain({ data: [{ id: 'x' }], error: null });
      },
      insert: (row: any) => {
        h.inserts.push({ table, row });
        return makeChain({ data: null, error: null });
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
/** Ticket con saldo = importe del pago (el caso normal). */
const ticketTotals = (due: number, paid = 0, tenders = 0) => ({ data: { totals: { due, paid }, _embedded: { payments: new Array(tenders).fill({ id: 't' }) } } });

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
    // El handler lee el saldo del ticket antes de postear: por defecto, saldo = importe.
    h.get.mockResolvedValue(ticketTotals(2000));
    h.existingPosId = null;
    h.existingAdditionalProps = null;
    h.paymentUpdates.length = 0;
    h.inserts.length = 0;
    h.posIdUpdateError = null;
  });

  it('applies the payment: marca jsonb SIEMPRE y pos_id best-effort', async () => {
    h.post.mockResolvedValue({ data: { id: 'OMNI-PAY-1' } });

    const out = await run();

    expect(out).toMatchObject({ omnivore_payment_id: 'OMNI-PAY-1' });
    expect(out).not.toHaveProperty('adjusted');
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-9/payments', payment, expect.anything());
    const marca = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.additional_properties?.omnivore_payment_id === 'OMNI-PAY-1');
    expect(marca).toBeTruthy();
    const upd = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.pos_id === 'OMNI-PAY-1');
    expect(upd).toBeTruthy();
    expect(h.inserts).toHaveLength(0); // sin ajuste no hay nota
  });

  // ── La marca sobrevive al 23505 de `payments_site_pos_id_uniq` (Aloha recicla ids) ────────────
  it('pos_id choca con el índice único → la marca jsonb queda escrita igual y el job completa', async () => {
    h.post.mockResolvedValue({ data: { id: '105906178' } });
    h.posIdUpdateError = { code: '23505', message: 'duplicate key value violates unique constraint "payments_site_pos_id_uniq"' };

    const out = await run();

    expect(out).toMatchObject({ omnivore_payment_id: '105906178' });
    const marca = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.additional_properties?.omnivore_payment_id === '105906178');
    expect(marca).toBeTruthy();
  });

  it('con la marca jsonb puesta, el reintento sale por already_applied aunque pos_id siga null', async () => {
    h.existingPosId = null;
    h.existingAdditionalProps = { omnivore_payment_id: '105906178' };

    const out = await run();

    expect(out).toMatchObject({ skipped: 'already_applied', omnivore_payment_id: '105906178' });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('si no se puede leer el estado del pago NO se postea (retryable)', async () => {
    // El mock de `select` no modela error: se fuerza vía un `maybeSingle` que devuelve error.
    const orig = h.existingAdditionalProps;
    h.existingAdditionalProps = { __force_read_error: true } as any;
    // Simular error de lectura reemplazando temporalmente el resultado del select de payments.
    const { supabase } = await import('../../src/lib/supabase');
    const spy = vi.spyOn(supabase as any, 'from').mockImplementation((table: string) => {
      const chain: any = {
        select: () => chain, eq: () => chain, neq: () => chain, not: () => chain, in: () => chain, limit: () => chain, order: () => chain,
        maybeSingle: async () => (table === 'payments' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (ok: any) => Promise.resolve({ data: [], error: null }).then(ok),
        update: () => chain, insert: () => chain,
      };
      return chain;
    });
    try {
      const err: any = await run().then(() => null, (e) => e);
      expect(err?.code).toBe('OMNIVORE_PAYMENT_STATE_READ_FAILED');
      expect(err?.retryable).toBe(true);
      expect(h.post).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      h.existingAdditionalProps = orig;
    }
  });

  // ── Saldo del ticket antes del tender (incidente 10614: 145.36 cobrados vs 144.87 de ticket) ───
  it('amount > due → postea el DUE (propina intacta), anota en order_notes y deja el ajuste en el pago', async () => {
    h.get.mockResolvedValue(ticketTotals(14487));
    h.post.mockResolvedValue({ data: { id: 'OMNI-PAY-3' } });
    const body = { ...payment, amount: 14536, tip: 2680 };

    const out = await handler({ stepInput: {}, jobPayload: { payment_id: 10483, order_id: 10614, ticket_id: '20260918-20003', payment: body }, context: {}, job, step });

    expect(out).toMatchObject({ omnivore_payment_id: 'OMNI-PAY-3', adjusted: true, requested: 14536, applied: 14487, due: 14487 });
    expect(h.post).toHaveBeenCalledWith('/tickets/20260918-20003/payments', { ...body, amount: 14487 }, expect.anything());
    // El payload del job NO se muta.
    expect(body.amount).toBe(14536);
    // Nota de sistema en la orden, con las tres cifras.
    const nota = h.inserts.find((i) => i.table === 'order_notes');
    expect(nota.row).toMatchObject({ site_id: 25, order_id: 10614, is_system: true });
    expect(nota.row.content).toContain('$145.36');
    expect(nota.row.content).toContain('$144.87');
    expect(nota.row.content).toContain('$0.49');
    // Registro en el pago junto a la marca.
    const upd = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.additional_properties?.omnivore_tender_adjustment);
    expect(upd.patch.additional_properties.omnivore_payment_id).toBe('OMNI-PAY-3');
    expect(upd.patch.additional_properties.omnivore_tender_adjustment).toMatchObject({ kind: 'amount_capped_to_due', requested: 14536, applied: 14487, difference: 49 });
  });

  it('amount == due → postea tal cual, sin nota ni ajuste', async () => {
    h.get.mockResolvedValue(ticketTotals(2000));
    h.post.mockResolvedValue({ data: { id: 'OMNI-PAY-4' } });

    const out = await run();

    expect(out).toEqual({ omnivore_payment_id: 'OMNI-PAY-4' });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-9/payments', payment, expect.anything());
    expect(h.inserts.find((i) => i.table === 'order_notes')).toBeUndefined();
  });

  it('amount < due (split / parcial) → postea tal cual', async () => {
    h.get.mockResolvedValue(ticketTotals(9000));
    h.post.mockResolvedValue({ data: { id: 'OMNI-PAY-5' } });

    const out = await run();

    expect(out).toEqual({ omnivore_payment_id: 'OMNI-PAY-5' });
    expect(h.post).toHaveBeenCalledWith('/tickets/TICKET-9/payments', payment, expect.anything());
  });

  it('due == 0 (ticket ya pagado) → NO postea, completa con ticket_already_paid y deja nota', async () => {
    h.get.mockResolvedValue(ticketTotals(0, 2000, 1));

    const out = await run();

    expect(out).toMatchObject({ skipped: 'ticket_already_paid', due: 0, requested: 2000, tenders_en_ticket: 1 });
    expect(h.post).not.toHaveBeenCalled();
    const nota = h.inserts.find((i) => i.table === 'order_notes');
    expect(nota.row.content).toContain('ya estaba pagado');
    const upd = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.additional_properties?.omnivore_tender_adjustment);
    expect(upd.patch.additional_properties.omnivore_tender_adjustment).toMatchObject({ kind: 'ticket_already_paid', requested: 2000, applied: 0 });
    // Sin marca de aplicado: no hay tender nuestro.
    expect(h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.additional_properties?.omnivore_payment_id)).toBeUndefined();
  });

  it('si el GET del saldo falla NO se postea (retryable)', async () => {
    h.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 503'), { isAxiosError: true, response: { status: 503, data: { errors: [{ error: 'agent_offline', description: 'x' }] } } }));
    h.post.mockResolvedValue({ data: { id: 'NO-DEBERÍA' } });

    const err: any = await run().then(() => null, (e) => e);

    expect(err?.code).toBe('OMNIVORE_AGENT_OFFLINE');
    expect(err?.retryable).toBe(true);
    expect(h.post).not.toHaveBeenCalled();
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

  // ── «Error closing ticket»: el POS aplicó el pago y falló al cerrar ──────────────────────────
  //
  // Incidente real en Numen (site VIVO) el 2026-08-27. El ticket `20260827-10027` acabó con DOS
  // tenders: `95420423` (importe 1) y `95420424` (importe 0, cambio 1). El segundo lo creó el
  // reintento de MCM después de que el POS ya hubiera aplicado el primero.
  const errorCierreFallido = (reason: unknown = 'Error closing ticket.') =>
    Object.assign(new Error('Request failed with status code 500'), {
      isAxiosError: true,
      response: {
        status: 500,
        data: {
          errors: [
            {
              error: 'internal_error',
              description: 'The system threw an unexpected error.',
              ...(reason === undefined ? {} : { metadata: { reason } }),
            },
          ],
        },
      },
    });

  it('«Error closing ticket»: NO se reintenta — reintentar es exactamente lo que duplicó el tender', async () => {
    h.post.mockRejectedValue(errorCierreFallido());
    const s = freshStep();

    const err: any = await runWithStep(s).then(
      () => { throw new Error('debió lanzar'); },
      (e) => e
    );

    expect(err.code).toBe('OMNIVORE_PAYMENT_APPLIED_CLOSE_FAILED');
    expect(err.retryable).toBe(false);
    // Sin escalada de intentos: esto no es contención, es un pago que YA entró.
    expect(s.max_attempts).toBe(5);
  });

  it('«Error closing ticket»: deja ESCRITO que el pago entró, para que nadie lo reenvíe a mano', async () => {
    h.post.mockRejectedValue(errorCierreFallido());

    await runWithStep(freshStep()).catch(() => {});

    // 1. Marcador en el pago (jsonb, y pos_id best-effort) → cualquier intento posterior sale por `already_applied`.
    const marca = h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.additional_properties?.omnivore_payment_id);
    expect(marca.patch.additional_properties.omnivore_payment_id).toBe('applied_close_failed');
    expect(h.paymentUpdates.find((u) => u.table === 'payments' && u.patch.pos_id === 'applied_close_failed')).toBeTruthy();

    // 2. Mensaje accionable en la orden. Sin esto se vería «pago fallido», alguien lo reenviaría
    //    y el duplicado entraría por la otra puerta.
    const issue = h.paymentUpdates.find((u) => u.table === 'orders' && u.patch.issues);
    expect(issue.patch.issues.friendly_error).toContain('cerralo en el terminal');
    expect(issue.patch.issues.payment_id).toBe(55);
  });

  it('el marcador cierra el círculo: con él puesto, un intento posterior NO postea', async () => {
    h.existingAdditionalProps = { omnivore_payment_id: 'applied_close_failed' };

    const out = await run();

    expect(out).toMatchObject({ skipped: 'already_applied' });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('normaliza el reason: mayúsculas, espacios y el punto final no desactivan la protección', async () => {
    for (const variante of ['Error closing ticket.', 'error closing ticket', '  ERROR CLOSING TICKET.  ']) {
      h.post.mockReset();
      h.paymentUpdates.length = 0;
      h.post.mockRejectedValue(errorCierreFallido(variante));

      const err: any = await runWithStep(freshStep()).then(() => null, (e) => e);
      expect(err?.code, `variante ${JSON.stringify(variante)}`).toBe('OMNIVORE_PAYMENT_APPLIED_CLOSE_FAILED');
    }
  });

  it('OTRO internal_error sigue siendo reintentable — no se toca el resto del slug', async () => {
    h.post.mockRejectedValue(errorCierreFallido('Something else entirely'));

    const err: any = await runWithStep(freshStep()).then(() => null, (e) => e);

    expect(err.code).toBe('OMNIVORE_INTERNAL_ERROR');
    expect(err.retryable).toBe(true);
    // Y NO se marca el pago como aplicado: aquí no sabemos que entrara.
    expect(h.paymentUpdates.find((u) => u.table === 'payments')).toBeUndefined();
  });

  it('internal_error SIN metadata sigue siendo reintentable', async () => {
    // Se construye a mano: pasarle `undefined` al helper activaría su valor por defecto y el
    // error acabaría llevando el `reason` que este caso justamente quiere omitir.
    h.post.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 500'), {
        isAxiosError: true,
        response: {
          status: 500,
          data: { errors: [{ error: 'internal_error', description: 'The system threw an unexpected error.' }] },
        },
      }),
    );

    const err: any = await runWithStep(freshStep()).then(() => null, (e) => e);

    expect(err.code).toBe('OMNIVORE_INTERNAL_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('en un reintento, si el GET del ticket falla NO se postea (guarda conservada)', async () => {
    h.get.mockRejectedValue(omnivoreError('pos_offline', 503));
    h.post.mockResolvedValue({ data: { id: 'NO-DEBERÍA' } });

    const err: any = await handler({
      stepInput: {},
      jobPayload: { payment_id: 55, order_id: 123, ticket_id: 'TICKET-9', payment },
      context: {},
      job,
      step: { ...freshStep(), attempt_count: 1 },
    }).then(() => null, (e) => e);

    expect(err).toBeTruthy();
    expect(h.post).not.toHaveBeenCalled();
  });
});
