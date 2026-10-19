import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { employeeRow, LocationHolder, mergeRosters, samePerson } from '../../src/handlers/omnivore/sync/employees-multi';

const h = (location_id: number, first_name: string, last_name: string, manager = false, employee_id = `e${location_id}`): LocationHolder => ({
  location_id, employee_id, pos_id: `p${location_id}`, first_name, last_name, check_name: first_name, manager,
});

describe('samePerson', () => {
  it('ignora acentos, mayúsculas y puntuación; acepta un apellido que empieza con el otro', () => {
    expect(samePerson(h(1, 'Neyda', 'Rodríguez'), h(2, 'NEYDA', 'Rodriguez'))).toBe(true);
    expect(samePerson(h(1, 'Training', 'Online.'), h(2, 'Training', 'Online'))).toBe(true);
    expect(samePerson(h(1, 'Isidro', 'Rodríguez'), h(2, 'Isidro', 'Rodriguez Mercado'))).toBe(true);
    expect(samePerson(h(1, 'Frances', 'Del Valle'), h(2, 'Miguel A.', 'Carrillo Santos'))).toBe(false);
    expect(samePerson(h(1, 'Ana', ''), h(2, 'Ana', 'Pérez'))).toBe(false);
  });
});

describe('mergeRosters', () => {
  it('misma persona en varias sucursales: una fila, gerente si lo es en alguna', () => {
    const [m] = mergeRosters(new Map([['1111', [h(3, 'Neyda', 'Rodríguez'), h(1, 'Neyda', 'Rodriguez', true)]]]));
    expect(m).toMatchObject({ login: '1111', samePerson: true, manager: true });
    expect(m!.holders.map((x) => x.location_id)).toEqual([1, 3]);
  });
  it('PIN de personas distintas: gerente SOLO si todas lo son (menor privilegio)', () => {
    const [a] = mergeRosters(new Map([['2251', [h(1, 'Frances', 'Del Valle', true), h(2, 'Miguel', 'Carrillo')]]]));
    expect(a).toMatchObject({ samePerson: false, manager: false });
    const [b] = mergeRosters(new Map([['0000', [h(1, 'GERENTE', 'MGR', true), h(2, 'GERENTE', 'MANAGER', true)]]]));
    expect(b).toMatchObject({ samePerson: false, manager: true });
  });
});

describe('employeeRow', () => {
  const m = mergeRosters(new Map([['1111', [h(2, 'Neyda', 'Rodríguez', false, 'x2'), h(5, 'Neyda', 'Rodriguez', true, 'x5')]]]))[0]!;
  it('datos de la sucursal principal si trabaja ahí; sucursales en location_ids; detalle por sucursal', () => {
    const row = employeeRow(9, m, null, 5);
    expect(row).toMatchObject({ site_id: 9, login: '1111', first_name: 'Neyda', last_name: 'Rodriguez', omnivore_employee_id: 'x5', role: 'manager', location_ids: [2, 5] });
    expect(row.additional_properties).toMatchObject({ omnivore_pin_conflict: false, omnivore_locations: m.holders });
  });
  it('sin la principal, la de menor número; nunca baja a un admin; conserva additional_properties', () => {
    const row = employeeRow(9, m, { role: 'admin', additional_properties: { otra: 1 } }, 77);
    expect(row).toMatchObject({ omnivore_employee_id: 'x2', role: 'admin' });
    expect(row.additional_properties).toMatchObject({ otra: 1 });
  });
});
