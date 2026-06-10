import { AxiosError } from 'axios';
import { HandlerError } from '../../core/types';

/**
 * Omnivore error-slug → retry policy.
 *
 * Source: §3.4 of the migration spec + the Omnivore error reference. Omnivore
 * returns errors as `{ "errors": [ { "error": "<slug>", "description": "...",
 * "fields": [...], "metadata": { "pos_error": ... } } ] }` and — crucially —
 * transient POS/agent errors frequently come back with NON-5xx HTTP statuses
 * (e.g. 400/404/409) or even 200. Therefore the slug is AUTHORITATIVE over the
 * HTTP status when deciding retryability; the transport status is only a
 * fallback when no slug is present.
 */

/** Transient infra/POS errors → retry with backoff. */
export const OMNIVORE_RETRYABLE_SLUGS = new Set<string>([
  'pos_not_responding_retry',
  'timeout',
  'agent_offline',
  'pos_offline',
  'cache_still_loading',
  'internal_error',
]);

/** Business / payload errors → do NOT retry; surface to NEEDS_REVIEW (dead_letter). */
export const OMNIVORE_BUSINESS_SLUGS = new Set<string>([
  'reference_not_found',
  'reference_required',
  'invalid_payload',
  'parse_error',
  'not_found',
  'ticket_closed',
  'ticket_locked',
  'excessive_amount',
  'excessive_payment',
  'insufficient_amount',
  'entry_unavailable',
  'out_of_stock',
  'table_unavailable',
  'tips_not_allowed',
  'param_not_supported',
]);

/**
 * Ambiguous slugs: treated as retryable, but bounded by the step's
 * `max_attempts`, so they reach the dead-letter queue quickly for human review
 * instead of looping forever. (Decision per plan §Riesgos — confirmable.)
 */
export const OMNIVORE_AMBIGUOUS_SLUGS = new Set<string>([
  'pos_failure',
  'pos_config_error',
  'unknown',
  'bug',
]);

export interface OmnivoreApiError {
  slug: string;
  description: string;
  posError?: unknown;
  fields?: unknown;
}

/** Extract the first Omnivore error object from a response/error body, if any. */
export function extractOmnivoreError(body: unknown): OmnivoreApiError | null {
  if (!body || typeof body !== 'object') return null;
  const errors = (body as Record<string, unknown>)['errors'];
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const e = (errors[0] ?? {}) as Record<string, unknown>;
  const slug = typeof e['error'] === 'string' ? (e['error'] as string) : 'unknown';
  const metadata = (e['metadata'] ?? undefined) as Record<string, unknown> | undefined;
  return {
    slug,
    description: typeof e['description'] === 'string' ? (e['description'] as string) : slug,
    posError: metadata?.['pos_error'],
    fields: e['fields'],
  };
}

/** Whether an Omnivore slug should be retried. Business → false; everything else → true. */
export function isOmnivoreSlugRetryable(slug: string): boolean {
  if (OMNIVORE_BUSINESS_SLUGS.has(slug)) return false;
  // Transient, ambiguous, and anything unrecognised: retry (bounded by max_attempts).
  return true;
}

/**
 * Convert any thrown value / Omnivore error body into a HandlerError with the
 * correct `retryable` flag. The Omnivore slug (when present) wins over the HTTP
 * status. Returned HandlerError is preserved verbatim by `classifyError`, so the
 * executor schedules retry-vs-dead-letter correctly.
 */
export function mapOmnivoreError(err: unknown, fallbackCode = 'OMNIVORE_ERROR'): HandlerError {
  const ax = err as AxiosError | undefined;
  const isAxios =
    ax instanceof AxiosError ||
    (typeof err === 'object' && err !== null && (err as Record<string, unknown>)['isAxiosError'] === true);
  const status = isAxios ? ax?.response?.status : undefined;
  const body = isAxios ? ax?.response?.data : undefined;
  const apiErr = extractOmnivoreError(body);

  if (apiErr) {
    return new HandlerError(
      `Omnivore ${apiErr.slug}: ${apiErr.description}`,
      `OMNIVORE_${apiErr.slug.toUpperCase()}`,
      isOmnivoreSlugRetryable(apiErr.slug),
      status,
      body
    );
  }

  if (isAxios && ax) {
    if (!status) {
      return new HandlerError(ax.message || 'Network error', ax.code ?? 'NETWORK_ERROR', true);
    }
    const retryable = status >= 500 || status === 408 || status === 429;
    return new HandlerError(`HTTP ${status}: ${ax.message}`, `HTTP_${status}`, retryable, status, body);
  }

  const e = err as Error;
  return new HandlerError(e?.message ?? 'Unknown error', fallbackCode, true);
}

/**
 * Some Omnivore endpoints return HTTP 200 with an `errors` array. Call this on a
 * successful response body to surface those as HandlerErrors before treating the
 * step as succeeded.
 */
export function assertNoOmnivoreErrors(body: unknown): void {
  const apiErr = extractOmnivoreError(body);
  if (!apiErr) return;
  throw new HandlerError(
    `Omnivore ${apiErr.slug}: ${apiErr.description}`,
    `OMNIVORE_${apiErr.slug.toUpperCase()}`,
    isOmnivoreSlugRetryable(apiErr.slug),
    200,
    body
  );
}
