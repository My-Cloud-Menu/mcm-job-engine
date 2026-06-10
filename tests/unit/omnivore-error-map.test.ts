import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  extractOmnivoreError,
  isOmnivoreSlugRetryable,
  mapOmnivoreError,
  assertNoOmnivoreErrors,
  OMNIVORE_RETRYABLE_SLUGS,
  OMNIVORE_BUSINESS_SLUGS,
} from '../../src/handlers/omnivore/error-map';
import { HandlerError } from '../../src/core/types';

function omnivoreAxiosError(status: number, slug: string, description = 'desc'): AxiosError {
  return new AxiosError('Request failed', `HTTP_${status}`, undefined, undefined, {
    status,
    statusText: String(status),
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
    data: {
      errors: [{ error: slug, description, metadata: { pos_error: 'POS said no' } }],
    },
  });
}

describe('omnivore error-map', () => {
  it('extracts the first error slug, description and pos_error', () => {
    const e = extractOmnivoreError({
      errors: [{ error: 'out_of_stock', description: 'no soup', metadata: { pos_error: 'X' } }],
    });
    expect(e).toMatchObject({ slug: 'out_of_stock', description: 'no soup', posError: 'X' });
  });

  it('returns null when there is no errors array', () => {
    expect(extractOmnivoreError({ id: '123' })).toBeNull();
    expect(extractOmnivoreError(null)).toBeNull();
    expect(extractOmnivoreError('nope')).toBeNull();
  });

  it('classifies all transient slugs as retryable', () => {
    for (const slug of OMNIVORE_RETRYABLE_SLUGS) {
      expect(isOmnivoreSlugRetryable(slug), slug).toBe(true);
    }
  });

  it('classifies all business slugs as NOT retryable', () => {
    for (const slug of OMNIVORE_BUSINESS_SLUGS) {
      expect(isOmnivoreSlugRetryable(slug), slug).toBe(false);
    }
  });

  it('treats ambiguous/unknown slugs as retryable', () => {
    expect(isOmnivoreSlugRetryable('pos_failure')).toBe(true);
    expect(isOmnivoreSlugRetryable('something_brand_new')).toBe(true);
  });

  it('slug wins over HTTP status: transient slug on a 400 is retryable', () => {
    const he = mapOmnivoreError(omnivoreAxiosError(400, 'pos_not_responding_retry'));
    expect(he).toBeInstanceOf(HandlerError);
    expect(he.retryable).toBe(true);
    expect(he.code).toBe('OMNIVORE_POS_NOT_RESPONDING_RETRY');
    expect(he.statusCode).toBe(400);
  });

  it('slug wins over HTTP status: business slug on a 503 is NOT retryable', () => {
    const he = mapOmnivoreError(omnivoreAxiosError(503, 'out_of_stock'));
    expect(he.retryable).toBe(false);
    expect(he.code).toBe('OMNIVORE_OUT_OF_STOCK');
  });

  it('falls back to transport classification when there is no slug', () => {
    const ax = new AxiosError('boom', 'HTTP_500', undefined, undefined, {
      status: 500,
      statusText: '500',
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
      data: { message: 'server error' },
    });
    const he = mapOmnivoreError(ax);
    expect(he.retryable).toBe(true);
    expect(he.code).toBe('HTTP_500');

    const ax4xx = new AxiosError('bad', 'HTTP_404', undefined, undefined, {
      status: 404,
      statusText: '404',
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
      data: {},
    });
    expect(mapOmnivoreError(ax4xx).retryable).toBe(false);
  });

  it('marks network errors (no response) as retryable', () => {
    const he = mapOmnivoreError(new AxiosError('Network Error', 'ECONNRESET'));
    expect(he.retryable).toBe(true);
    expect(he.code).toBe('ECONNRESET');
  });

  it('assertNoOmnivoreErrors throws on a 200 body containing errors', () => {
    expect(() => assertNoOmnivoreErrors({ errors: [{ error: 'ticket_closed', description: 'closed' }] }))
      .toThrowError(/ticket_closed/);
    try {
      assertNoOmnivoreErrors({ errors: [{ error: 'ticket_closed', description: 'closed' }] });
    } catch (e) {
      expect((e as HandlerError).retryable).toBe(false);
    }
  });

  it('assertNoOmnivoreErrors is a no-op for clean bodies', () => {
    expect(() => assertNoOmnivoreErrors({ id: '537079' })).not.toThrow();
  });
});
