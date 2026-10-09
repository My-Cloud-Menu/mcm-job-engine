import { z } from 'zod';
import { registerHandler } from '../registry';
import { callSubsEdge } from './call-edge';

// subs.dispatch_notifications — vacía la bandeja de avisos de un negocio.
// UN job por negocio, no uno por aviso: N jobs para N correos es ruido en la cola.
const Input = z.object({ site_id: z.number() });
// Worker LOCAL de pruebas (ronda 2 iOTEK, «no enviar emails»): con `SUBS_DISPATCH_TEST_ONLY=1` la edge sólo procesa avisos a destinos de
// prueba (`notifications_suppress`) y deja los demás en cola. Producción NO lo pone: comportamiento de siempre.
const SOLO_PRUEBAS = process.env.SUBS_DISPATCH_TEST_ONLY === '1';

registerHandler('subs', 'dispatch_notifications', async ({ jobPayload }) => {
  const input = Input.parse(jobPayload);
  let total = { processed: 0, sent: 0, skipped: 0, failed: 0 };
  // La edge procesa por lotes; se insiste hasta vaciar, con tope para que un job no se eternice.
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const r: any = await callSubsEdge('subs-dispatch-notifications', SOLO_PRUEBAS ? { ...input, test_only: true } : input);
    total = {
      processed: total.processed + Number(r?.processed ?? 0),
      sent: total.sent + Number(r?.sent ?? 0),
      skipped: total.skipped + Number(r?.skipped ?? 0),
      failed: total.failed + Number(r?.failed ?? 0),
    };
    if (!r?.more) break;
  }
  return total;
});
