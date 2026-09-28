import { z } from 'zod';
import { registerHandler } from '../registry';
import { callSubsEdge } from './call-edge';

// subs.invoice_period — abre el ciclo siguiente de una suscripción.
// Lo encola el reloj (`subs_tick`) con la antelación que pida el negocio. No cobra.
const Input = z.object({ site_id: z.number(), subscription_id: z.string() });

registerHandler('subs', 'invoice_period', async ({ jobPayload }) => {
  const input = Input.parse(jobPayload);
  return await callSubsEdge('subs-invoice-period', input);
});
