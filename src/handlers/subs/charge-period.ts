import { z } from 'zod';
import { registerHandler } from '../registry';
import { callSubsEdge } from './call-edge';

// subs.charge_period — cobra un ciclo vencido con la tarjeta guardada.
//
// Ojo con lo que NO hace: una DECLINACIÓN no se reintenta aquí. La edge devuelve 200 con el
// resultado y el job termina OK; el siguiente intento lo programa el reloj con los offsets de
// dunning del negocio. Mezclar las dos cosas manda una tarjeta sin fondos al dead-letter tras
// cuatro reintentos de 30 segundos y despierta a alguien de madrugada por un impago normal.
const Input = z.object({
  site_id: z.number(), period_id: z.string(), retry_no: z.number().optional(),
});

registerHandler('subs', 'charge_period', async ({ jobPayload }) => {
  const { site_id, period_id } = Input.parse(jobPayload);
  return await callSubsEdge('subs-charge-period', { site_id, period_id }, 60_000);
});
