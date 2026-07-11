// Gap2 · Guard contra WIPE de un catálogo/roster vivo cuando un fetch de Omnivore vuelve parcial/degradado
// (un 200 corto/vacío, o el cap de paginación MAX_PAGES truncando en silencio — Omnivore NO expone un flag
// `complete`, a diferencia de Clover). Espeja el `archiveIsSafe` de Clover (mismos umbrales 0.15 / 10): nunca
// archivar/desactivar más de una fracción del set managed en una sola pasada; una merma mayor se trata como
// fetch sospechoso → saltar la operación destructiva (+ log). A diferencia de Clover, toma solo 2 contadores
// (Omnivore no da `complete`).
export const OMNI_ARCHIVE_MAX_SHRINK_RATIO = 0.15;
export const OMNI_ARCHIVE_MAX_SHRINK_ABS = 10;

/**
 * `false` ⇒ SALTAR archive/deactivate: el fetch vino vacío, o encogió más de la fracción permitida del set
 * managed actual (sospecha de fetch parcial/degradado).
 * @param fetchedCount filas managed que devolvió el POS en esta pasada.
 * @param managedCount filas managed actualmente en MCM (las que están en riesgo de archivar/desactivar).
 */
export function omniArchiveIsSafe(fetchedCount: number, managedCount: number): boolean {
  if (fetchedCount === 0 || managedCount === 0) return false;
  const wouldRemove = Math.max(0, managedCount - fetchedCount);
  const cap = Math.max(OMNI_ARCHIVE_MAX_SHRINK_ABS, Math.floor(managedCount * OMNI_ARCHIVE_MAX_SHRINK_RATIO));
  return wouldRemove <= cap;
}
