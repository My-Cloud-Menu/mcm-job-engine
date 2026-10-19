/**
 * Doble de `supabase` para las pruebas de la inyección Omnivore (Misión Omnivore Multisucursal).
 * Registra cada escritura con su tabla, su cambio y sus filtros, en orden, para poder afirmar QUÉ se escribió y
 * CUÁNDO (p. ej. la marca de intento antes del POST). Las lecturas `maybeSingle` de `orders` devuelven `state.order`.
 */
export interface FakeCall {
  table: string;
  op: 'select' | 'update' | 'insert';
  patch?: Record<string, unknown>;
  filters: Array<[string, ...unknown[]]>;
}

export interface FakeState {
  order: Record<string, unknown> | null;
  orderReadError: { message: string } | null;
  writeError: { message: string } | null;
  calls: FakeCall[];
  /** Línea de tiempo compartida con los mocks de red (`post:/tickets`, `update:orders`, …). */
  timeline: string[];
}

export function newFakeState(): FakeState {
  return { order: { status: 'in-kitchen', pos_injection_error: null }, orderReadError: null, writeError: null, calls: [], timeline: [] };
}

export function makeFakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      const call: FakeCall = { table, op: 'select', filters: [] };
      const builder: Record<string, unknown> = {};
      const chain = (name: string) => (...args: unknown[]) => {
        call.filters.push([name, ...args]);
        return builder;
      };
      for (const m of ['eq', 'or', 'not', 'in', 'is', 'limit', 'order', 'neq', 'contains']) builder[m] = chain(m);
      builder['select'] = (..._args: unknown[]) => {
        call.op = call.op === 'update' || call.op === 'insert' ? call.op : 'select';
        return builder;
      };
      builder['update'] = (patch: Record<string, unknown>) => {
        call.op = 'update';
        call.patch = patch;
        state.calls.push(call);
        state.timeline.push(`update:${table}`);
        return builder;
      };
      builder['insert'] = (row: Record<string, unknown>) => {
        call.op = 'insert';
        call.patch = row;
        state.calls.push(call);
        state.timeline.push(`insert:${table}`);
        return builder;
      };
      builder['maybeSingle'] = async () => {
        if (table === 'orders' && call.op === 'select') {
          return state.orderReadError ? { data: null, error: state.orderReadError } : { data: state.order, error: null };
        }
        return { data: null, error: null };
      };
      builder['then'] = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: call.op === 'select' ? null : state.writeError });
      return builder;
    },
  };
}

/** Escrituras a `orders.pos_injection_error` (en orden). */
export function statusWrites(state: FakeState): Array<Record<string, unknown> | null> {
  return state.calls
    .filter((c) => c.table === 'orders' && c.op === 'update' && c.patch && 'pos_injection_error' in c.patch && !('pos_id' in c.patch))
    .map((c) => c.patch!['pos_injection_error'] as Record<string, unknown> | null);
}
