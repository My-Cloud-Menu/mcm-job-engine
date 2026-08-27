import { AxiosInstance } from 'axios';

/**
 * Lectura y mapeo de MESAS y SECCIONES de Clover hacia `floor_elements`.
 *
 * **Sólo lectura, y sólo en un sentido.** MCM no crea mesas en Clover: está medido que
 * `POST /tables` las rechaza con `400 {"message":"Table coordinates are required"}` con los cinco
 * nombres de campo probados (`x/y`, `left/top`, `posX/posY`, `coordinates{}`, `x/y+width/height`).
 * Las mesas se dibujan en la app Tables del dispositivo, que es quien pone las coordenadas. Las
 * SECCIONES sí se pueden crear por API, pero tampoco se hace: mismo criterio que el catálogo.
 *
 * **El mapeo es DEFENSIVO a propósito.** El endpoint de mesas no está en la documentación pública
 * de Clover y el merchant sandbox tiene 0 mesas, así que no hay un payload real que mirar. Se leen
 * los campos de los que hay evidencia (`id`, `name`, `maxSeats`, `section`) probando varios alias,
 * y **el objeto crudo entero se guarda en `metadata.clover_raw`** para que nada se pierda aunque
 * Clover devuelva más de lo que aquí se contempla.
 */

export interface MesaClover {
  id: string;
  nombre: string;
  asientos: number | null;
  seccionId: string | null;
  seccionNombre: string | null;
  crudo: Record<string, unknown>;
}

const primero = (o: any, claves: string[]): any => {
  for (const k of claves) {
    const v = k.split('.').reduce((a: any, p) => (a == null ? a : a[p]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/** Trae secciones y mesas. Devuelve `completo:false` si algo vino degradado (no archivar). */
export async function fetchCloverTablesAndSections(
  client: AxiosInstance,
): Promise<{ mesas: MesaClover[]; secciones: any[]; completo: boolean }> {
  const secciones: any[] = [];
  let completo = true;

  try {
    const { data } = await client.get<any>('/tables/sections?limit=200&expand=tables');
    secciones.push(...(data?.elements ?? []));
  } catch {
    completo = false;   // sin secciones no se sabe a qué sala pertenece cada mesa
  }

  const nombrePorSeccion = new Map<string, string>();
  for (const s of secciones) if (s?.id) nombrePorSeccion.set(String(s.id), String(s.name ?? ''));

  const crudas: any[] = [];
  try {
    const { data } = await client.get<any>('/tables?limit=500');
    crudas.push(...(data?.elements ?? []));
  } catch {
    completo = false;
  }

  // Algunas cuentas devuelven las mesas ANIDADAS en la sección y `/tables` vacío; se unen las dos
  // vías y se deduplica por id, que es lo único fiable.
  for (const s of secciones) {
    for (const t of s?.tables?.elements ?? []) {
      if (t?.id) crudas.push({ ...t, section: t.section ?? { id: s.id, name: s.name } });
    }
  }

  const vistas = new Set<string>();
  const mesas: MesaClover[] = [];
  for (const t of crudas) {
    const id = t?.id != null ? String(t.id) : '';
    if (!id || vistas.has(id)) continue;
    vistas.add(id);
    const seccionId = primero(t, ['section.id', 'sectionId', 'tableSection.id']);
    mesas.push({
      id,
      nombre: String(primero(t, ['name', 'label', 'number']) ?? id),
      asientos: Number(primero(t, ['maxSeats', 'seats', 'capacity']) ?? NaN) || null,
      seccionId: seccionId != null ? String(seccionId) : null,
      seccionNombre: seccionId != null
        ? (nombrePorSeccion.get(String(seccionId)) || String(primero(t, ['section.name']) ?? '') || null)
        : null,
      crudo: t,
    });
  }

  return { mesas, secciones, completo };
}
