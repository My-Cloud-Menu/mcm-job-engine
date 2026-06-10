const REDACT_KEYS = new Set([
  'password', 'token', 'api_key', 'apikey', 'secret',
  'authorization', 'auth', 'access_token', 'refresh_token',
  'card_number', 'cvv', 'pin',
]);

const PARTIAL_KEYS = new Set(['phone', 'phone_number']);

/**
 * Recursively sanitize an object before logging or storing in DB.
 * Sensitive keys are replaced with '[REDACTED]'.
 * Phone fields are masked to show only the last 4 digits.
 */
export function sanitizePayload(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizePayload);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (REDACT_KEYS.has(lowerKey)) {
        result[key] = '[REDACTED]';
      } else if (PARTIAL_KEYS.has(lowerKey) && typeof value === 'string') {
        result[key] = '****' + value.slice(-4);
      } else {
        result[key] = sanitizePayload(value);
      }
    }
    return result;
  }

  return obj;
}
