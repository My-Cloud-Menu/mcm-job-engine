import { z } from 'zod';
import { registerHandler } from '../registry';
import { callSubsEdge } from '../subs/call-edge';

// store.reconcile_payments — la red de seguridad de los cobros de la tienda en línea (R4, §5.4).
//
// Lo encola `public.store_reconcile_enqueue()` (pg_cron cada 10 min) sólo para los negocios que lo activaron. Todo el
// trabajo lo hace la edge `store-payments-reconcile` (tiene las llaves de Stripe y la vía de cierre de pagos); aquí sólo
// se le pasa el negocio. Un 5xx se reintenta; la franja siguiente vuelve a pasar igual.

const Input = z.object({ site_id: z.number() });

registerHandler('store', 'reconcile_payments', async ({ jobPayload }) => {
  const input = Input.parse(jobPayload);
  return callSubsEdge('store-payments-reconcile', input, 60_000);
});
