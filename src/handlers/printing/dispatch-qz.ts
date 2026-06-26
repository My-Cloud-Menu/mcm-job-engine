import { z } from 'zod';
import { registerHandler } from '../registry';
import { HandlerError } from '../../core/types';
import { config } from '../../config';
import { logger } from '../../lib/logger';

// printing.dispatch_qz — delega el push al gateway WebSocket del mcm-print-service (Fase 5).
// El gateway encuentra el socket del cliente QZ por connection_id, envía sendPrint, ESPERA la respuesta
// del cliente y ACTUALIZA print_jobs de forma durable (printed/failed). Este handler solo interpreta el
// outcome para que el engine aplique retry/backoff/dead-letter (cliente offline → retryable).

const Input = z.object({ print_job_id: z.string(), site_id: z.number() });
const TIMEOUT_MS = 35_000;

registerHandler('printing', 'dispatch_qz', async ({ jobPayload }) => {
  const { print_job_id, site_id } = Input.parse(jobPayload);
  const url = `${config.printing.serviceUrl}/internal/qz/dispatch`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.printing.internalToken },
      body: JSON.stringify({ print_job_id, site_id }),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new HandlerError(`qz gateway network: ${String(err?.message ?? err)}`, 'QZ_GATEWAY_NETWORK', true);
  } finally {
    clearTimeout(timer);
  }

  const body: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    // 5xx/503/429/408 → transitorio (cliente offline, gateway saturado). 4xx → fatal.
    const retryable = res.status >= 500 || res.status === 503 || res.status === 429 || res.status === 408;
    throw new HandlerError(
      `qz gateway HTTP ${res.status}: ${body?.error ?? ''}`,
      body?.code ?? `QZ_HTTP_${res.status}`,
      retryable, res.status, body,
    );
  }

  if (body?.outcome === 'printed') {
    logger.info({ site_id, print_job_id }, 'printing.dispatch_qz printed');
    return { printed: true };
  }

  // El gateway ya marcó print_jobs failed/retry; lanzamos para que el engine reintente/dead-letter.
  throw new HandlerError(
    `qz print failed: ${body?.code ?? 'QZ_FAILED'}`,
    body?.code ?? 'QZ_FAILED',
    body?.retryable ?? true, undefined, body,
  );
});
