import { AxiosError } from 'axios';
import { HandlerError } from '../../core/types';

/**
 * Clover error → retry policy (§3.4 of the migration spec).
 *
 * Unlike Omnivore (slug-based), Clover signals failures via HTTP status + a
 * message body. Policy:
 *  - 429 → retryable, honoring the `Retry-After` header (polling raises call volume).
 *  - 401 → NOT retryable (the token is a static per-merchant API key; there is no
 *          OAuth refresh, so a 401 = bad/expired credentials → NEEDS_REVIEW).
 *  - 5xx / network → retryable.
 *  - 400 / 403 / 404 (and other 4xx) → NOT retryable (payload/business → NEEDS_REVIEW).
 */

/** Parse a `Retry-After` header (seconds, or HTTP-date) into seconds. */
export function parseRetryAfter(headerValue: unknown): number | undefined {
  if (headerValue == null) return undefined;
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const s = String(raw).trim();
  if (s === '') return undefined;
  const asNum = Number(s);
  if (Number.isFinite(asNum)) return Math.max(0, Math.round(asNum));
  const asDate = Date.parse(s);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return undefined;
}

/** Extract a human-readable Clover error message from a response body. */
export function extractCloverErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' ? body : null;
  }
  const b = body as Record<string, unknown>;
  const m = b['message'] ?? (b['error'] as Record<string, unknown> | undefined)?.['message'] ?? b['error'];
  return typeof m === 'string' ? m : null;
}

/**
 * Convert any thrown value into a HandlerError with the correct `retryable`
 * flag and (for 429) a `retryAfterSeconds` hint. Preserved verbatim by
 * `classifyError`, so the executor schedules retry/dead-letter correctly.
 */
export function mapCloverError(err: unknown, fallbackCode = 'CLOVER_ERROR'): HandlerError {
  const ax = err as AxiosError | undefined;
  const isAxios =
    ax instanceof AxiosError ||
    (typeof err === 'object' && err !== null && (err as Record<string, unknown>)['isAxiosError'] === true);

  if (!isAxios || !ax) {
    const e = err as Error;
    return new HandlerError(e?.message ?? 'Unknown error', fallbackCode, true);
  }

  const status = ax.response?.status;
  const body = ax.response?.data;
  const detail = extractCloverErrorMessage(body);
  const msgBase = detail ? `: ${detail}` : ` ${ax.message}`;

  if (!status) {
    // Network error (no response) → retryable.
    return new HandlerError(ax.message || 'Network error', ax.code ?? 'NETWORK_ERROR', true);
  }

  if (status === 429) {
    const retryAfter = parseRetryAfter(ax.response?.headers?.['retry-after']);
    return new HandlerError(`Clover 429 (rate limited)${msgBase}`, 'HTTP_429', true, status, body, retryAfter);
  }

  if (status === 401) {
    return new HandlerError(
      `Clover 401 (auth — token invalid/expired)${msgBase}`,
      'CLOVER_UNAUTHORIZED',
      false,
      status,
      body
    );
  }

  if (status >= 500) {
    return new HandlerError(`Clover ${status}${msgBase}`, `HTTP_${status}`, true, status, body);
  }

  // Other 4xx (400/403/404/409/…) → business/payload → not retryable.
  return new HandlerError(`Clover ${status}${msgBase}`, `HTTP_${status}`, false, status, body);
}
