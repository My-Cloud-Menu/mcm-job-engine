import { HandlerError } from '../../core/types';
import { config } from '../../config';

/**
 * Llama a una edge interna del módulo.
 *
 * El engine NO habla con Stripe ni con el calculador de órdenes: no tiene el SDK ni las
 * credenciales, y duplicarlas aquí sería una segunda copia que mantener. Es el mismo patrón que ya
 * usan `delivery.dispatch` y `clover.push_orders`.
 *
 * **Qué se reintenta y qué no:** 5xx/429/408 son transitorios y vuelven; un 4xx es una respuesta
 * firme (el negocio no tiene cuenta, el ciclo está cerrado, la tarjeta declinó) y reintentarla sólo
 * gasta intentos y acaba despertando a un humano por nada. Una DECLINACIÓN llega como 200 con
 * `ok:false`: el job hizo su trabajo, el siguiente intento lo programa el dunning, no el backoff.
 */
export async function callSubsEdge(
  slug: string, input: Record<string, unknown>, timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  const url = `${config.supabase.url}/functions/v1/${slug}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
      `${slug} network error: ${String(err?.message ?? err)}`,
      `SUBS_EDGE_NETWORK`, true,
    );
  } finally {
    clearTimeout(timer);
  }

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new HandlerError(
      `${slug} HTTP ${res.status}: ${body?.error ?? ''}`,
      `SUBS_EDGE_HTTP_${res.status}`, retryable, res.status, body,
    );
  }
  return body ?? {};
}
