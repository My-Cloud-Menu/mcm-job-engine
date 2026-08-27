import { vi, describe, it, expect } from 'vitest';
vi.mock('../../src/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { imprimirEnClover } from '../../src/handlers/clover/inject/print';

/**
 * `POST /print_event` de Clover. Comportamiento medido contra el merchant sandbox
 * `7ES0TRRRYJCY1`: con 0 dispositivos emparejados responde
 * `400 {"message":"The default printing device is missing"}`, y pasa igual mandando `deviceRef`
 * o `printer` en el cuerpo. Ese caso NO se arregla reintentando.
 */
const cli = (impl: any) => ({ post: vi.fn(impl) }) as any;
const err = (message: string) => Object.assign(new Error('req failed'), { response: { data: { message } } });

describe('impresión en Clover (Fase 2)', () => {
  it('apagada por defecto: no llama a Clover', async () => {
    const c = cli(async () => ({ data: { id: 'PE1' } }));
    const r = await imprimirEnClover(c, 'ORD1', false, 99990004);
    expect(r).toEqual({ status: 'skip', reason: 'cloverPrintOnFire apagado' });
    expect(c.post).not.toHaveBeenCalled();
  });

  it('sin ticket de Clover tampoco llama', async () => {
    const c = cli(async () => ({ data: {} }));
    expect(await imprimirEnClover(c, '', true, 99990004)).toEqual({ status: 'skip', reason: 'sin ticket de Clover' });
    expect(c.post).not.toHaveBeenCalled();
  });

  it('encendida: postea orderRef y devuelve el id del evento', async () => {
    const c = cli(async () => ({ data: { id: 'PE9' } }));
    const r = await imprimirEnClover(c, 'ORD1', true, 99990004);
    expect(r).toEqual({ status: 'printed', print_event_id: 'PE9' });
    expect(c.post).toHaveBeenCalledWith('/print_event', { orderRef: { id: 'ORD1' } });
  });

  it('el 400 de "sin dispositivo" se distingue (no es un fallo a reintentar)', async () => {
    const c = cli(async () => { throw err('The default printing device is missing'); });
    expect(await imprimirEnClover(c, 'ORD1', true, 99990004)).toEqual({ status: 'no_device' });
  });

  it('cualquier otro fallo se reporta pero NO lanza', async () => {
    const c = cli(async () => { throw err('Internal error'); });
    const r = await imprimirEnClover(c, 'ORD1', true, 99990004);
    expect(r.status).toBe('failed');
  });

  it('NUNCA lanza, ni con un error sin forma conocida', async () => {
    const c = cli(async () => { throw new Error('boom'); });
    await expect(imprimirEnClover(c, 'ORD1', true, 99990004)).resolves.toBeTruthy();
  });
});
