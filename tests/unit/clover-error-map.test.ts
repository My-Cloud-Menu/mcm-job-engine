import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { mapCloverError, parseRetryAfter, extractCloverErrorMessage } from '../../src/handlers/clover/error-map';
import { classifyError } from '../../src/core/error-classifier';
import { HandlerError } from '../../src/core/types';

function cloverAxiosError(status: number, data: unknown = {}, headers: Record<string, string> = {}): AxiosError {
  return new AxiosError('Request failed', `HTTP_${status}`, undefined, undefined, {
    status,
    statusText: String(status),
    headers: new AxiosHeaders(headers),
    config: { headers: new AxiosHeaders() },
    data,
  });
}

describe('clover error-map', () => {
  it('parseRetryAfter handles seconds, dates, and empties', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    const future = new Date(Date.now() + 60_000).toUTCString();
    const secs = parseRetryAfter(future)!;
    expect(secs).toBeGreaterThan(50);
    expect(secs).toBeLessThanOrEqual(60);
  });

  it('extractCloverErrorMessage pulls message/error', () => {
    expect(extractCloverErrorMessage({ message: 'bad price' })).toBe('bad price');
    expect(extractCloverErrorMessage({ error: 'nope' })).toBe('nope');
    expect(extractCloverErrorMessage('raw string')).toBe('raw string');
    expect(extractCloverErrorMessage({})).toBeNull();
  });

  it('429 → retryable with Retry-After hint', () => {
    const he = mapCloverError(cloverAxiosError(429, { message: 'slow down' }, { 'retry-after': '12' }));
    expect(he).toBeInstanceOf(HandlerError);
    expect(he.retryable).toBe(true);
    expect(he.code).toBe('HTTP_429');
    expect(he.retryAfterSeconds).toBe(12);
  });

  it('401 → NOT retryable (static token, no refresh)', () => {
    const he = mapCloverError(cloverAxiosError(401, { message: 'unauthorized' }));
    expect(he.retryable).toBe(false);
    expect(he.code).toBe('CLOVER_UNAUTHORIZED');
  });

  it('5xx → retryable', () => {
    expect(mapCloverError(cloverAxiosError(503)).retryable).toBe(true);
  });

  it('400/403/404 → NOT retryable', () => {
    for (const s of [400, 403, 404, 409]) {
      expect(mapCloverError(cloverAxiosError(s)).retryable, `status ${s}`).toBe(false);
    }
  });

  it('network error (no response) → retryable', () => {
    const he = mapCloverError(new AxiosError('Network Error', 'ECONNRESET'));
    expect(he.retryable).toBe(true);
    expect(he.code).toBe('ECONNRESET');
  });

  it('classifyError preserves retryAfterSeconds from HandlerError', () => {
    const he = new HandlerError('x', 'HTTP_429', true, 429, {}, 7);
    const c = classifyError(he);
    expect(c.retryAfterSeconds).toBe(7);
    expect(c.retryable).toBe(true);
  });
});
