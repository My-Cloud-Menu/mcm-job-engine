import { z } from 'zod';
import { registerHandler } from '../registry';
import { HandlerError } from '../../core/types';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { loadPrintJob, loadPrinter, markDispatched, markPrinted, markFailed } from './repo';

// printing.dispatch_star — push REST a StarPrint con la robustez del engine (retry/backoff/dead-letter).
// Star no tiene confirmación asíncrona del dispositivo → 'printed' = aceptado por el servicio Star.
// Creds por sitio en printers.config (star_api_url/star_api_key) con fallback a env.

const Input = z.object({ print_job_id: z.string(), site_id: z.number() });
const TIMEOUT_MS = 20_000;

registerHandler('printing', 'dispatch_star', async ({ jobPayload }) => {
  const { print_job_id, site_id } = Input.parse(jobPayload);

  const job = await loadPrintJob(print_job_id, site_id);
  if (!job) throw new HandlerError(`print_job not found ${print_job_id}`, 'PRINT_JOB_NOT_FOUND', false);
  if (job.status === 'printed' || job.status === 'cancelled') return { skipped: job.status };

  const printer = await loadPrinter(job.printer_id, site_id);
  const apiUrl = printer?.['config']?.star_api_url || config.printing.starApiUrl;
  const apiKey = printer?.['config']?.star_api_key || config.printing.starApiKey;
  const body = job.payload?.['star_body'];
  if (!body) throw new HandlerError('missing payload.star_body', 'STAR_NO_BODY', false);

  await markDispatched(print_job_id, site_id);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new HandlerError(`star network error: ${String(err?.message ?? err)}`, 'STAR_NETWORK', true);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    if (!retryable) await markFailed(print_job_id, site_id, `STAR_HTTP_${res.status}`, false);
    throw new HandlerError(`star HTTP ${res.status}`, `STAR_HTTP_${res.status}`, retryable, res.status);
  }

  await markPrinted(print_job_id, site_id);
  logger.info({ site_id, print_job_id }, 'printing.dispatch_star printed');
  return { printed: true };
});
