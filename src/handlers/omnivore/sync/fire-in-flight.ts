/**
 * Fire en vuelo (espejo de `omnivore-fire-stamp.ts::isFireInFlight` del edge).
 *
 * `send-to-kitchen` escribe `additional_properties.omnivore_fire.in_flight_until` ANTES de POSTear
 * los ítems al POS (fase 0) y lo cierra al estampar. Mientras esté vigente, el merge managed debe
 * SALTAR la orden: el ticket puede tener ya el ítem y MCM todavía no su `item_id` → merge-ar ahora
 * conserva la línea "sin enviar" y añade la del POS (orden doblada; Coca-Cola, 138 órdenes el 11-sep).
 * Un valor ausente, null o no-ISO cuenta como "no hay fire" (el marcador expira solo a los 90 s).
 */
export function isFireInFlight(ap: unknown, nowIso: string = new Date().toISOString()): boolean {
  const until = (ap as { omnivore_fire?: { in_flight_until?: unknown } } | null | undefined)?.omnivore_fire?.in_flight_until;
  return typeof until === 'string' && !Number.isNaN(Date.parse(until)) && until > nowIso;
}
