import { vi, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  friendlyInjectionMessage,
  buildInjectionStatus,
  canRetryInjection,
  evaluateOrderGuard,
  statusForFailure,
} from '../../src/handlers/omnivore/inject/injection-status';
import {
  OMNIVORE_RETRYABLE_SLUGS,
  OMNIVORE_BUSINESS_SLUGS,
  OMNIVORE_AMBIGUOUS_SLUGS,
} from '../../src/handlers/omnivore/error-map';
import messages from '../../src/handlers/omnivore/inject/injection-messages.json';

describe('mensajes para el staff', () => {
  it('cada slug de Omnivore que conoce el worker tiene su texto (nada sale genérico por olvido)', () => {
    const slugs = [...OMNIVORE_RETRYABLE_SLUGS, ...OMNIVORE_BUSINESS_SLUGS, ...OMNIVORE_AMBIGUOUS_SLUGS].filter(
      (s) => !['unknown', 'bug'].includes(s)
    );
    const missing = slugs.filter((s) => !(messages.codes as Record<string, string>)[`OMNIVORE_${s.toUpperCase()}`]);
    expect(missing).toEqual([]);
  });

  it('cada código propio de la inyección tiene su texto', () => {
    const own = [
      'NO_INTEGRATION', 'NO_INTEGRATION_FOR_LOCATION', 'AMBIGUOUS_INTEGRATION', 'INTEGRATION_LOOKUP_FAILED',
      'TICKET_SEARCH_FAILED', 'ITEMS_PARTIAL', 'TICKET_WITHOUT_PAYMENT', 'TICKET_DUE_REMAINING',
      'ORDER_CANCELLED_WITH_TICKET', 'ORDER_READ_FAILED', 'ATTEMPT_MARKER_FAILED', 'MISSING_TICKET_BODY',
      'MISSING_TICKET_ID', 'MISSING_CONTEXT', 'MISSING_ITEMS', 'OMNIVORE_UNMAPPED_ITEMS', 'OMNIVORE_UNMAPPED_MODIFIERS',
      'OMNIVORE_LOCATION_REQUIRED',
    ];
    expect(own.filter((c) => !(messages.codes as Record<string, string>)[c])).toEqual([]);
  });

  it('código desconocido → texto del paso; cualquier HTTP 5xx → error interno del POS', () => {
    expect(friendlyInjectionMessage('XYZ', 'add_items')).toBe(messages.steps.add_items);
    expect(friendlyInjectionMessage(null, 'create_payment')).toBe(messages.steps.create_payment);
    expect(friendlyInjectionMessage('HTTP_507', 'create_order')).toBe(messages.codes.HTTP_500);
  });

  it('textos cortos y sin jerga técnica', () => {
    for (const [code, text] of Object.entries(messages.codes as Record<string, string>)) {
      expect(text.length, code).toBeLessThanOrEqual(140);
      expect(text, code).not.toMatch(/omnivore_|HTTP|axios|undefined|null/i);
    }
  });

  it('paridad: la copia de la edge es idéntica (mismo texto en edge, worker y pantalla)', () => {
    const edge = path.resolve(
      __dirname,
      '../../../mcm-edge-functions/supabase/functions/_shared/helpers/omnivore-injection-messages.ts'
    );
    if (!fs.existsSync(edge)) return; // fuera del workspace (CI del worker solo): se verifica en el de la edge
    // La edge es un módulo .ts con el JSON entre marcas (Deno no importa JSON sin import attributes en el bundle).
    const src = fs.readFileSync(edge, 'utf8');
    const start = src.indexOf('/*JSON-START*/');
    const end = src.indexOf('/*JSON-END*/');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(JSON.parse(src.slice(start + '/*JSON-START*/'.length, end))).toEqual(messages);
  });

  it('paridad: el barrido de la base (R1) marca con el mismo texto del catálogo', () => {
    const sweep = path.resolve(
      __dirname,
      '../../../mcm-edge-functions/supabase/migrations/20261019002128_omni_ms_06_barrido_inyeccion.sql'
    );
    if (!fs.existsSync(sweep)) return; // fuera del workspace
    const sql = fs.readFileSync(sweep, 'utf8');
    expect(sql).toContain(`'code', 'DISPATCH_NO_RESPONSE'`);
    expect(sql).toContain(`'message', '${messages.codes.DISPATCH_NO_RESPONSE}'`);
    expect(canRetryInjection('failed', 'DISPATCH_NO_RESPONSE')).toBe(true);
  });
});

describe('estado de la inyección', () => {
  const now = new Date('2026-10-19T00:00:00Z');

  it('arma el estado con el texto, el paso, el intento y los errores crudos', () => {
    const s = buildInjectionStatus({
      state: 'failed', step: 'add_items', code: 'OMNIVORE_OUT_OF_STOCK', detail: 'x'.repeat(900),
      attempt: 5, maxAttempts: 5, ticketId: 'T-1', responseBody: { errors: [{ error: 'out_of_stock' }] }, now,
    });
    expect(s).toEqual({
      state: 'failed', step: 'add_items', code: 'OMNIVORE_OUT_OF_STOCK', message: messages.codes.OMNIVORE_OUT_OF_STOCK,
      detail: 'x'.repeat(500), attempt: 5, max_attempts: 5, ticket_id: 'T-1', can_retry: true, at: '2026-10-19T00:00:00.000Z',
      errors: [{ error: 'out_of_stock' }],
    });
  });

  it('«Reintentar» se ofrece solo cuando sirve', () => {
    expect(canRetryInjection('retrying', 'OMNIVORE_POS_OFFLINE')).toBe(false); // ya se está reintentando solo
    expect(canRetryInjection('failed', 'OMNIVORE_POS_OFFLINE')).toBe(true);
    expect(canRetryInjection('needs_action', 'ITEMS_PARTIAL')).toBe(true);
    expect(canRetryInjection('needs_action', 'TICKET_WITHOUT_PAYMENT')).toBe(true);
    expect(canRetryInjection('needs_action', 'TICKET_DUE_REMAINING')).toBe(false);
    expect(canRetryInjection('needs_action', 'ORDER_CANCELLED_WITH_TICKET')).toBe(false);
    expect(canRetryInjection('resolved', 'X')).toBe(false);
  });

  it('statusForFailure usa la misma regla de reintento que el executor', () => {
    const err = { code: 'OMNIVORE_POS_OFFLINE', message: 'off', retryable: true };
    expect(statusForFailure(err, { attempt_count: 0, max_attempts: 3 }, 'create_order', { now }).state).toBe('retrying');
    expect(statusForFailure(err, { attempt_count: 2, max_attempts: 3 }, 'create_order', { now }).state).toBe('failed');
    expect(statusForFailure({ ...err, retryable: false }, { attempt_count: 0, max_attempts: 3 }, 'create_order', { now }).state).toBe('failed');
  });

  it('guarda de la orden: cancelada/papelera para; resuelta a mano para; lo demás sigue (también errores viejos en arreglo)', () => {
    expect(evaluateOrderGuard({ status: 'cancelled' }).stop).toBe('cancelled');
    expect(evaluateOrderGuard({ status: 'trash' }).stop).toBe('cancelled');
    expect(evaluateOrderGuard({ status: 'in-kitchen', pos_injection_error: { state: 'resolved' } }).stop).toBe('resolved');
    expect(evaluateOrderGuard({ status: 'in-kitchen', pos_injection_error: [{ error: 'x' }] }).stop).toBeNull();
    expect(evaluateOrderGuard({ status: 'new-order', pos_injection_error: { state: 'failed' } }).stop).toBeNull();
    expect(evaluateOrderGuard(null).stop).toBeNull();
  });
});
