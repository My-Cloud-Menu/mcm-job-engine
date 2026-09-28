import { z } from 'zod';
import { registerHandler } from '../registry';
import { HandlerError } from '../../core/types';
import { config } from '../../config';

// subs.harvest_instrument — recoge la tarjeta que el cliente acaba de guardar al comprar.
//
// El engine NO habla con Stripe: no tiene el SDK ni las credenciales, y duplicarlas aquí sería una
// segunda copia que mantener. Llama a la edge interna `subs-harvest-instrument`, que ya vive donde
// están las llaves — es el mismo patrón de `delivery.dispatch` y `clover.push_orders`.
//
// Va en un job APARTE del que crea la suscripción: son dos llamadas a Stripe y no pueden retrasar
// (ni tumbar) una suscripción que ya está cobrada.

const Input = z.object({
  site_id: z.number(),
  payment_id: z.number(),
  checkout_session_id: z.string(),
});

const TIMEOUT_MS = 30_000;

registerHandler('subs', 'harvest_instrument', async ({ jobPayload }) => {
  const input = Input.parse(jobPayload);
  const url = `${config.supabase.url}/functions/v1/subs-harvest-instrument`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS + 5_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
        apikey: config.supabase.serviceRoleKey,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new HandlerError(
      `subs-harvest-instrument network error: ${String(err?.message ?? err)}`,
      'SUBS_HARVEST_NETWORK', true,
    );
  } finally {
    clearTimeout(timer);
  }

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 5xx/429/408 transitorio; 4xx fatal (el negocio no tiene cuenta de Stripe, la sesión no existe…):
    // reintentar eso sólo gasta intentos y acaba despertando a un humano por nada.
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new HandlerError(
      `subs-harvest-instrument HTTP ${res.status}: ${body?.error ?? ''}`,
      `SUBS_HARVEST_HTTP_${res.status}`, retryable, res.status, body,
    );
  }
  return body ?? {};
});
