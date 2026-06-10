import { describe, it, expect } from 'vitest';
import { sanitizePayload } from '../../src/lib/sanitize';

describe('sanitizePayload', () => {
  it('redacts known sensitive keys', () => {
    const input = {
      api_key: 'sk-abc123',
      token: 'Bearer xyz',
      password: 'hunter2',
      secret: 'mysecret',
      authorization: 'Basic abc',
      access_token: 'at_123',
      card_number: '4111111111111111',
      cvv: '123',
    };

    const result = sanitizePayload(input) as Record<string, unknown>;

    for (const key of Object.keys(input)) {
      expect(result[key], `${key} should be redacted`).toBe('[REDACTED]');
    }
  });

  it('keeps non-sensitive keys unchanged', () => {
    const input = { order_id: 'abc', amount: 100, status: 'pending' };
    const result = sanitizePayload(input) as Record<string, unknown>;
    expect(result).toMatchObject(input);
  });

  it('masks phone numbers to last 4 digits', () => {
    const result = sanitizePayload({ phone: '5551234567', phone_number: '+15559876543' }) as Record<string, unknown>;
    expect(result['phone']).toBe('****4567');
    expect(result['phone_number']).toBe('****6543');
  });

  it('recursively sanitizes nested objects', () => {
    const input = {
      user: {
        name: 'Alice',
        credentials: { api_key: 'secret123' },
      },
    };
    const result = sanitizePayload(input) as { user: { credentials: { api_key: string } } };
    expect(result.user.credentials.api_key).toBe('[REDACTED]');
  });

  it('sanitizes arrays', () => {
    const input = [{ api_key: 'key1' }, { api_key: 'key2' }];
    const result = sanitizePayload(input) as Array<{ api_key: string }>;
    expect(result[0]!.api_key).toBe('[REDACTED]');
    expect(result[1]!.api_key).toBe('[REDACTED]');
  });

  it('handles null and undefined without throwing', () => {
    expect(sanitizePayload(null)).toBeNull();
    expect(sanitizePayload(undefined)).toBeUndefined();
  });

  it('returns primitives unchanged', () => {
    expect(sanitizePayload(42)).toBe(42);
    expect(sanitizePayload('hello')).toBe('hello');
    expect(sanitizePayload(true)).toBe(true);
  });

  it('is case-insensitive for key matching', () => {
    const result = sanitizePayload({ API_KEY: 'value', Token: 'tok' }) as Record<string, unknown>;
    expect(result['API_KEY']).toBe('[REDACTED]');
    expect(result['Token']).toBe('[REDACTED]');
  });
});
