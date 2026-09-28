import { z } from 'zod';
import { registerHandler } from '../registry';
import { callSubsEdge } from '../subs/call-edge';

// store.test_card_complete — la «confirmación retrasada» de Test Card (tarjeta 5126, misión §5.3).
//
// Hace de webhook que llega tarde: a los 2 minutos del cobro aprobado, cierra el pago por la edge `test-card-confirm`
// en modo interno (service_role), que usa la misma vía que Stripe (`updatePaymentCompletedSuccessfully`). Si el pago ya
// se cerró o la orden se canceló, la edge responde 200/409 y aquí no hay nada que reintentar.

const Input = z.object({ site_id: z.number(), payment_id: z.number() });

registerHandler('store', 'test_card_complete', async ({ jobPayload }) => {
  const input = Input.parse(jobPayload);
  try {
    return await callSubsEdge('test-card-confirm', { ...input, internal_complete: true });
  } catch (e) {
    // 409 = ya no hay nada que cerrar (pago movido u orden cancelada): respuesta firme, no un fallo del job.
    // Por forma y no por `instanceof`: el error puede venir de otra copia del módulo (pruebas, recarga en caliente).
    const status = (e as { statusCode?: number } | null)?.statusCode;
    if (status === 409) {
      return { skipped: 'nothing_to_complete', detail: (e as Error).message };
    }
    throw e;
  }
});
