/**
 * Emparejar el `title` de un ticket de Clover con una mesa de MCM.
 *
 * **Por qué el título.** Clover NO publica a qué mesa pertenece una orden: medido contra el
 * sandbox, `/tables/{id}` sólo devuelve geometría, `/tables/{id}/orders` da 405, y la orden no trae
 * ningún campo de mesa ni pidiendo todos los expands. El `title` es el único rastro que queda.
 *
 * MIRROR de `mcm-edge-functions/supabase/functions/_shared/helpers/clover-table-match.ts`.
 * Si cambia una, cambia la otra.
 */

/** Lo que necesitamos de una mesa del plano de Clover. */
export type MesaCandidata = {
  id: string;
  table_name?: string | null;
  table_number?: string | null;
  revenue_center_id?: string | null;
};

/**
 * ¿Este título lo escribió MCM?
 *
 * ANTI-BUCLE, imprescindible: MCM escribe el título de las órdenes que inyecta
 * (`"Mesa 5 · #10015"`, `"Room 200 · #10009"`, `"MCM #10677"`). Sin esta guarda, el emparejamiento
 * por número extraería el **id de la orden** —`"1 · #10014"` daría `10014`— y podría casar con una
 * mesa que se llamara así.
 */
export const esTituloEscritoPorMCM = (titulo: string): boolean =>
  / · #\d+\s*$/.test(titulo) || /^MCM #\d+\s*$/.test(titulo);

/**
 * Resuelve la mesa a partir del título. `null` si no hay coincidencia — nunca inventa.
 *
 *   1. **Exacto** contra `table_name`, para sites cuyas mesas se llamen como el título.
 *   2. **Dígitos finales** contra `table_number`: el terminal titula `"Mesa 5"` mientras su mesa se
 *      llama `"5"`, así que el nombre exacto no casa. Aguanta cualquier prefijo sin depender de la
 *      palabra, que cambia con el idioma y la versión del terminal.
 *
 * Se exigen los dígitos AL FINAL (`"Mesa 5A"` no casa): mejor no atar que atar a la mesa equivocada.
 */
export const resolverMesaDesdeTitulo = (
  tituloCrudo: string | null | undefined,
  mesas: MesaCandidata[],
): MesaCandidata | null => {
  const titulo = String(tituloCrudo ?? '').trim();
  if (!titulo) return null;
  if (esTituloEscritoPorMCM(titulo)) return null;

  const exacta = mesas.find((m) => String(m.table_name ?? '').trim() === titulo);
  if (exacta) return exacta;

  const m = titulo.match(/(\d+)\s*$/);
  if (!m) return null;
  const numero = String(Number(m[1])); // normaliza "05" -> "5"

  return (
    mesas.find((mesa) => String(mesa.table_number ?? '').trim() === numero) ??
    mesas.find((mesa) => String(mesa.table_name ?? '').trim() === numero) ??
    null
  );
};

/** La referencia que MCM guarda para una experiencia de mesa: el NÚMERO, nunca la etiqueta.
 *  Misma convención que `open-table-order` y `transfer-order-table`; la interfaz añade el «Mesa ». */
export const referenciaDeMesa = (mesa: MesaCandidata): string =>
  String(mesa.table_number ?? mesa.id);
