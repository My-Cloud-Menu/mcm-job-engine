import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { classifyError } from '../../src/core/error-classifier';
import { HandlerError } from '../../src/core/types';

function makeAxiosError(status: number, message = 'Request failed'): AxiosError {
  const err = new AxiosError(
    message,
    `HTTP_${status}`,
    undefined,
    undefined,
    {
      status,
      data: { error: 'test' },
      statusText: String(status),
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    }
  );
  return err;
}

describe('classifyError', () => {
  it('preserves HandlerError fields exactly', () => {
    const err = new HandlerError('bad input', 'BAD_INPUT', false, 400, { detail: 'x' });
    const result = classifyError(err);
    expect(result).toMatchObject({
      message: 'bad input',
      code: 'BAD_INPUT',
      retryable: false,
      statusCode: 400,
      responseBody: { detail: 'x' },
    });
  });

  it('marks 5xx as retryable', () => {
    const result = classifyError(makeAxiosError(500));
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('marks 4xx (except 408 and 429) as NOT retryable', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const result = classifyError(makeAxiosError(status));
      expect(result.retryable, `status ${status} should not be retryable`).toBe(false);
    }
  });

  it('marks 408 and 429 as retryable', () => {
    expect(classifyError(makeAxiosError(408)).retryable).toBe(true);
    expect(classifyError(makeAxiosError(429)).retryable).toBe(true);
  });

  it('marks network errors (no response) as retryable', () => {
    const err = new AxiosError('Network Error', 'ECONNREFUSED');
    const result = classifyError(err);
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('ECONNREFUSED');
  });

  it('marks unknown errors as retryable', () => {
    const result = classifyError(new Error('something went wrong'));
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.message).toBe('something went wrong');
  });

  it('handles null/undefined gracefully', () => {
    const result = classifyError(null);
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('UNKNOWN_ERROR');
  });
});
