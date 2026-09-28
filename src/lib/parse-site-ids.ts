/** "70100000, 123" → [70100000, 123]. Vacío o ausente → null. Un valor no numérico aborta el arranque. */
export function parseSiteIds(raw: string | undefined): number[] | null {
  if (!raw || !raw.trim()) return null;
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    if (!/^\d+$/.test(s)) throw new Error(`WORKER_SITE_IDS inválido: "${s}"`);
    return Number(s);
  });
  return ids.length ? ids : null;
}
