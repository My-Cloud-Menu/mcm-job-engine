import { describe, it, expect } from 'vitest';
import { aplicarOverridesLocales, CAMPOS_PROTEGIDOS } from '../../src/handlers/clover/sync/local-overrides';

const CAMPOS = CAMPOS_PROTEGIDOS.products;
const correr = (prev: any, clover: any, ap: any = {}, activo = true) => {
  const apCopia = { ...ap };
  const r = aplicarOverridesLocales(CAMPOS, prev, { ...clover }, apCopia, activo);
  return { ...r, ap: apCopia };
};

describe('overrides locales de campos cosméticos', () => {
  it('sin edición local, gana Clover', () => {
    const r = correr({ name: 'Café', description: 'rico' },
                     { name: 'Café Latte', description: 'rico' },
                     { cloverBaseline: { name: 'Café', description: 'rico' } });
    expect(r.base.name).toBe('Café Latte');
    expect(r.overrides).toEqual([]);
    expect(r.ap.cloverOverrides).toBeUndefined();
  });

  it('con edición local, gana MCM y queda anotado', () => {
    const r = correr({ name: 'Café Especial de la Casa', description: 'rico' },
                     { name: 'Café', description: 'rico' },
                     { cloverBaseline: { name: 'Café', description: 'rico' } });
    expect(r.base.name).toBe('Café Especial de la Casa');
    expect(r.overrides).toEqual(['name']);
    expect(r.ap.cloverOverrides).toEqual(['name']);
  });

  it('el override AGUANTA aunque Clover cambie el nombre después', () => {
    const r = correr({ name: 'Mi Nombre', description: 'x' },
                     { name: 'Nombre Nuevo De Clover', description: 'x' },
                     { cloverBaseline: { name: 'Nombre Viejo', description: 'x' } });
    expect(r.base.name).toBe('Mi Nombre');
    // y la línea base avanza al valor nuevo de Clover
    expect(r.ap.cloverBaseline.name).toBe('Nombre Nuevo De Clover');
  });

  it('cada campo va por su cuenta: se puede sobrescribir el nombre y no la descripción', () => {
    const r = correr({ name: 'Mío', description: 'la de Clover' },
                     { name: 'Clover', description: 'la de Clover' },
                     { cloverBaseline: { name: 'Clover', description: 'la de Clover' } });
    expect(r.base.name).toBe('Mío');
    expect(r.base.description).toBe('la de Clover');
    expect(r.overrides).toEqual(['name']);
  });

  it('volver a poner el valor de Clover LIBERA el override solo', () => {
    const r = correr({ name: 'Clover Actual', description: 'x' },
                     { name: 'Clover Actual', description: 'x' },
                     { cloverBaseline: { name: 'Clover Actual', description: 'x' } });
    expect(r.overrides).toEqual([]);
    expect(r.ap.cloverOverrides).toBeUndefined();
  });

  it('`cloverAdoptOnNextSync` fuerza volver a lo de Clover y se auto-borra', () => {
    const r = correr({ name: 'Mío', description: 'mía' },
                     { name: 'Clover', description: 'de Clover' },
                     { cloverBaseline: { name: 'Otro', description: 'otra' }, cloverAdoptOnNextSync: true });
    expect(r.base.name).toBe('Clover');
    expect(r.base.description).toBe('de Clover');
    expect(r.overrides).toEqual([]);
    expect(r.ap.cloverAdoptOnNextSync).toBeUndefined();
  });

  it('ARRANQUE sin línea base: una diferencia se trata como override (no se borra el trabajo)', () => {
    const r = correr({ name: 'Editado a mano', description: 'x' },
                     { name: 'Clover', description: 'x' }, {});
    expect(r.base.name).toBe('Editado a mano');
    expect(r.overrides).toEqual(['name']);
    expect(r.ap.cloverBaseline.name).toBe('Clover');
  });

  it('ARRANQUE sin diferencia: no inventa un override', () => {
    const r = correr({ name: 'Igual', description: 'x' }, { name: 'Igual', description: 'x' }, {});
    expect(r.overrides).toEqual([]);
  });

  it('con la bandera APAGADA es un NO-OP total: ni toca additional_properties', () => {
    const r = correr({ name: 'Mío', description: 'mía' },
                     { name: 'Clover', description: 'de Clover' },
                     { cloverBaseline: { name: 'Otro', description: 'otra' } }, false);
    expect(r.base.name).toBe('Clover');
    expect(r.overrides).toEqual([]);
    // NO se escribe la línea base: si no, cada site del mundo pagaría una escritura por fila en
    // el primer sync tras desplegar sin haber pedido nada. Al encender, el arranque ya hace lo
    // correcto (respeta las diferencias que encuentre).
    expect(r.ap.cloverBaseline).toEqual({ name: 'Otro', description: 'otra' });
  });

  it('en un ALTA no hay nada que proteger', () => {
    const r = correr(null, { name: 'Nuevo', description: 'd' }, {});
    expect(r.base.name).toBe('Nuevo');
    expect(r.overrides).toEqual([]);
  });
});
