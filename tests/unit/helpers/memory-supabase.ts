/**
 * Doble EN MEMORIA de `supabase` para las pruebas de los syncs multi-sucursal (Misión Omnivore Multisucursal).
 * Tablas = arrays de filas. Soporta lo que usan los handlers: select/eq/in/is/order/range/limit/maybeSingle, insert,
 * upsert (onConflict), update y delete con filtros, y rpc. Registra cada operación con sus filtros para poder afirmar
 * que TODA escritura lleva `site_id`.
 */
export type Row = Record<string, any>;

export interface MemOp {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  filters: Array<[string, string, unknown]>;
  payload?: unknown;
  onConflict?: string;
}

export interface MemState {
  tables: Record<string, Row[]>;
  ops: MemOp[];
  rpcs: Array<{ name: string; args: unknown }>;
  /** Claves únicas por tabla (lista de columnas). Un insert que choca devuelve 23505. */
  unique: Record<string, string[][]>;
  /** Error forzado por tabla+op (p. ej. `pos_connection_health:upsert`). */
  failOn: Record<string, { message: string; code?: string }>;
  nextId: number;
}

export function newMemState(tables: Record<string, Row[]> = {}): MemState {
  return { tables: structuredClone(tables), ops: [], rpcs: [], unique: {}, failOn: {}, nextId: 1000 };
}

const matches = (row: Row, filters: Array<[string, string, unknown]>) =>
  filters.every(([kind, col, val]) => {
    if (kind === 'eq') return String(row[col]) === String(val);
    if (kind === 'in') return (val as unknown[]).map(String).includes(String(row[col]));
    if (kind === 'is') return val === null ? row[col] == null : row[col] === val;
    return true;
  });

export function makeMemSupabase(state: MemState) {
  const table = (name: string) => (state.tables[name] ??= []);
  const conflictKey = (name: string, row: Row) =>
    (state.unique[name] ?? []).find((cols) => table(name).some((r) => cols.every((c) => String(r[c]) === String(row[c]))));

  return {
    rpc: async (name: string, args: unknown) => {
      state.rpcs.push({ name, args });
      return { data: null, error: null };
    },
    from(name: string) {
      const op: MemOp = { table: name, op: 'select', filters: [] };
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      let limitN: number | null = null;
      let single = false;
      const b: Record<string, any> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (op.filters.push(['eq', c, v]), b);
      b.in = (c: string, v: unknown[]) => (op.filters.push(['in', c, v]), b);
      b.is = (c: string, v: unknown) => (op.filters.push(['is', c, v]), b);
      b.order = () => b;
      b.limit = (n: number) => ((limitN = n), b);
      b.range = (a: number, z: number) => ((rangeFrom = a), (rangeTo = z), b);
      b.insert = (payload: Row | Row[]) => ((op.op = 'insert'), (op.payload = payload), b);
      b.upsert = (payload: Row | Row[], opts?: { onConflict?: string }) => (
        (op.op = 'upsert'), (op.payload = payload), (op.onConflict = opts?.onConflict), b
      );
      b.update = (payload: Row) => ((op.op = 'update'), (op.payload = payload), b);
      b.delete = () => ((op.op = 'delete'), b);
      b.maybeSingle = () => ((single = true), b.then((x: any) => x));
      b.throwOnError = () => b;

      const run = () => {
        state.ops.push(op);
        const forced = state.failOn[`${name}:${op.op}`];
        if (forced) return { data: null, error: forced };
        const rows = table(name);
        if (op.op === 'select') {
          let out = rows.filter((r) => matches(r, op.filters));
          if (rangeFrom != null) out = out.slice(rangeFrom, (rangeTo ?? rangeFrom) + 1);
          if (limitN != null) out = out.slice(0, limitN);
          if (single) return { data: out[0] ?? null, error: null };
          return { data: structuredClone(out), error: null };
        }
        if (op.op === 'insert') {
          const list = Array.isArray(op.payload) ? (op.payload as Row[]) : [op.payload as Row];
          for (const r of list) if (conflictKey(name, r)) return { data: null, error: { message: 'duplicate key', code: '23505' } };
          for (const r of list) rows.push({ id: r.id ?? state.nextId++, ...structuredClone(r) });
          return { data: null, error: null };
        }
        if (op.op === 'upsert') {
          const list = Array.isArray(op.payload) ? (op.payload as Row[]) : [op.payload as Row];
          const cols = (op.onConflict ?? 'id').split(',');
          for (const r of list) {
            const i = rows.findIndex((x) => cols.every((c) => String(x[c]) === String(r[c])));
            if (i >= 0) rows[i] = { ...rows[i], ...structuredClone(r) };
            else rows.push({ id: r.id ?? state.nextId++, ...structuredClone(r) });
          }
          return { data: null, error: null };
        }
        if (op.op === 'update') {
          rows.forEach((r, i) => { if (matches(r, op.filters)) rows[i] = { ...r, ...structuredClone(op.payload as Row) }; });
          return { data: null, error: null };
        }
        if (op.op === 'delete') {
          state.tables[name] = rows.filter((r) => !matches(r, op.filters));
          return { data: null, error: null };
        }
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return reject ? reject(e) : Promise.reject(e); }
      };
      return b;
    },
  };
}

/** Escrituras (no lecturas) a una tabla. */
export const writesTo = (state: MemState, table: string) => state.ops.filter((o) => o.table === table && o.op !== 'select');

/** ¿Lleva el filtro `site_id = siteId`? */
export const hasSiteFilter = (op: MemOp, siteId: number) => op.filters.some(([k, c, v]) => k === 'eq' && c === 'site_id' && String(v) === String(siteId));
