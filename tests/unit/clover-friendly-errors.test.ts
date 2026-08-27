import { describe, it, expect } from 'vitest';
import { classifyCloverError, extractCloverDetail } from '../../src/handlers/clover/friendly-errors';

/** Un error de axios realista: `mapCloverError` y esta capa sólo miran el status si lleva el flag. */
const ax = (status: number | null, data: unknown) =>
  Object.assign(new Error('boom'), {
    isAxiosError: true,
    response: status == null ? undefined : { status, data },
  });

describe('extraer el texto útil del cuerpo', () => {
  // El worker sólo leía `message`; `details` es donde Clover pone lo concreto.
  it('junta `message` y `details`', () => {
    expect(extractCloverDetail({ message: 'Not Found', details: 'Order not found.' }))
      .toBe('Not Found: Order not found.');
  });
  it('acepta cuerpo de texto plano (el 405 de Clover lo es)', () => {
    expect(extractCloverDetail('405 GET not allowed.')).toBe('405 GET not allowed.');
  });
  it('tolera cuerpos vacíos', () => {
    expect(extractCloverDetail(null)).toBeNull();
    expect(extractCloverDetail({})).toBeNull();
  });
});

describe('clasificación por status', () => {
  it('sin respuesta = problema de red, transitorio', () => {
    const r = classifyCloverError(ax(null, null));
    expect(r.tier).toBe('generic');
  });
  it('429 y 5xx son transitorios', () => {
    expect(classifyCloverError(ax(429, {})).tier).toBe('generic');
    expect(classifyCloverError(ax(503, {})).tier).toBe('generic');
  });
  it('401 y 403 son de configuración, no del negocio', () => {
    expect(classifyCloverError(ax(401, {})).tier).toBe('structural');
    expect(classifyCloverError(ax(403, {})).tier).toBe('structural');
  });

  // MEDIDO: en Clover 405 es RUTA DESCONOCIDA, no "método no permitido". Verificado contra
  // /merchant_plans/{id}, que sí existe y también da 405.
  it('405 es ruta desconocida → estructural', () => {
    const r = classifyCloverError(ax(405, '405 GET not allowed.'));
    expect(r.tier).toBe('structural');
    expect(r.message).toMatch(/no está disponible/);
  });

  it('404 es accionable y lo dice en cristiano', () => {
    const r = classifyCloverError(ax(404, { message: 'Not Found', details: 'Order not found.' }));
    expect(r.tier).toBe('actionable');
    expect(r.message).toMatch(/ya no existen/);
    expect(r.detail).toBe('Not Found: Order not found.');
  });
});

describe('afinado por texto — sólo lo verificado', () => {
  // Medido al intentar borrar una orden pagada en el sandbox.
  it('"associated payment" → el ticket ya tiene pago', () => {
    const r = classifyCloverError(ax(400, { message: 'Can not delete order with an associated payment.' }));
    expect(r.tier).toBe('actionable');
    expect(r.message).toMatch(/ya tiene un pago/);
  });
  // Medido: "Section id required", "Table coordinates are required".
  it('"required" → falta un dato, es estructural', () => {
    expect(classifyCloverError(ax(400, { message: 'Section id required' })).tier).toBe('structural');
  });

  // ── La regla que NO se porta ──────────────────────────────────────────────────────────────
  // La edge tiene `msg.includes("payment")` → "El ticket ya tiene un pago aplicado". No hay ni una
  // respuesta de Clover transcrita que lo respalde, y se MIDIÓ lo contrario (H-N9): Clover acepta
  // un segundo pago sobre una orden ya pagada, SIN error. Este test fija que no se porte.
  it('NO afirma "ya tiene un pago" por que el texto contenga «payment»', () => {
    const r = classifyCloverError(ax(400, { message: 'Payment method not supported' }));
    expect(r.message).not.toMatch(/ya tiene un pago/);
    expect(r.message).toBe('El POS rechazó la operación.');
  });

  it('un 4xx cualquiera cae en el genérico accionable', () => {
    const r = classifyCloverError(ax(400, { message: 'Algo raro' }));
    expect(r.tier).toBe('actionable');
    expect(r.detail).toBe('Algo raro');
  });
});

// Los handlers no atrapan el error de axios: atrapan el `HandlerError` que ya produjo
// `mapCloverError`. Si esta capa sólo entendiera la forma de axios, devolvería "el POS no
// responde" para TODO — el fallo silencioso que precisamente viene a evitar.
describe('acepta también la forma HandlerError', () => {
  const he = (statusCode: number, responseBody: unknown, message = 'Clover error') =>
    Object.assign(new Error(message), { code: 'HTTP_' + statusCode, statusCode, responseBody });

  it('clasifica un 404 que llega como HandlerError', () => {
    const r = classifyCloverError(he(404, { message: 'Not Found', details: 'Order not found.' }));
    expect(r.status).toBe(404);
    expect(r.tier).toBe('actionable');
    expect(r.message).toMatch(/ya no existen/);
  });

  it('clasifica un 401 que llega como HandlerError', () => {
    expect(classifyCloverError(he(401, {})).tier).toBe('structural');
  });

  it('un HandlerError SIN status sigue siendo transitorio', () => {
    const r = classifyCloverError(Object.assign(new Error('timeout of 20000ms exceeded'), {
      code: 'ECONNABORTED', responseBody: undefined, statusCode: undefined,
    }));
    expect(r.tier).toBe('generic');
  });
});
