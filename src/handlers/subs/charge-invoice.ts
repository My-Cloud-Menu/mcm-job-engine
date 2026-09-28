import { z } from 'zod';
import { registerHandler } from '../registry';
import { callSubsEdge } from './call-edge';

// subs.charge_invoice — cobra la FACTURA vencida de un cliente: un cargo por todo lo que debe.
//
// Es la vía normal. `subs.charge_period` queda para cobrar una línea suelta.
//
// Ojo con lo que NO hace: una DECLINACIÓN no se reintenta aquí. La edge devuelve 200 con el
// resultado y el job termina OK; el siguiente intento lo programa el reloj con los offsets de
// dunning del negocio. Mezclar las dos cosas manda una tarjeta sin fondos al dead-letter tras
// cuatro reintentos de 30 segundos y despierta a alguien de madrugada por un impago normal.
//
// El tiempo de espera es mayor que el del ciclo suelto porque una factura de treinta equipos monta
// un carrito de treinta líneas antes de cobrar, y ese cálculo lo hace el calculador de órdenes.
const Input = z.object({
  site_id: z.number(), invoice_id: z.string(), retry_no: z.number().optional(),
});

registerHandler('subs', 'charge_invoice', async ({ jobPayload }) => {
  const { site_id, invoice_id } = Input.parse(jobPayload);
  return await callSubsEdge('subs-charge-invoice', { site_id, invoice_id }, 120_000);
});
