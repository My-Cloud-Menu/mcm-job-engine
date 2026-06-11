import { describe, it, expect } from 'vitest';
import { calculateBackoff } from '../../src/core/backoff';

describe('calculateBackoff', () => {
  it('returns null when attempt exceeds profile length', () => {
    expect(calculateBackoff(10, 'pos_injection')).toBeNull();
    expect(calculateBackoff(5, 'pos_sync')).toBeNull();
  });

  it('returns a future date for valid attempts', () => {
    const before = Date.now();
    const result = calculateBackoff(1, 'pos_injection');
    expect(result).toBeInstanceOf(Date);
    // pos_injection attempt 1 = 0s base + jitter, so may be now or slightly in future
    expect(result!.getTime()).toBeGreaterThanOrEqual(before - 100);
  });

  it('uses longer delays for later attempts', () => {
    const attempt1 = calculateBackoff(1, 'notifications');
    const attempt3 = calculateBackoff(3, 'notifications');
    expect(attempt3!.getTime()).toBeGreaterThan(attempt1!.getTime());
  });

  it('applies jitter within ±20% of base', () => {
    const baseSeconds = 300; // notifications attempt 3
    const now = Date.now();
    const results: number[] = [];

    for (let i = 0; i < 50; i++) {
      const d = calculateBackoff(3, 'notifications');
      results.push((d!.getTime() - now) / 1000);
    }

    const min = Math.min(...results);
    const max = Math.max(...results);

    // With ±20% jitter: 300 ± 60s → [240, 360]
    expect(min).toBeGreaterThanOrEqual(230);
    expect(max).toBeLessThanOrEqual(370);
  });

  it('falls back to default profile for unknown queues', () => {
    const result = calculateBackoff(1, 'unknown_queue');
    expect(result).toBeInstanceOf(Date);
    // default[0] = 60s, ±20% → between 48s and 72s
    const secondsFromNow = (result!.getTime() - Date.now()) / 1000;
    expect(secondsFromNow).toBeGreaterThanOrEqual(40);
    expect(secondsFromNow).toBeLessThanOrEqual(80);
  });

  it('webhooks profile has longest delays', () => {
    const webhookAttempt5 = calculateBackoff(5, 'webhooks');
    const notifAttempt5 = calculateBackoff(5, 'notifications');
    expect(webhookAttempt5!.getTime()).toBeGreaterThan(notifAttempt5!.getTime());
  });

  it('payment_injection job_type retries every ~30s (overrides the pos_injection queue profile)', () => {
    const now = Date.now();
    // attempts 1..4 → ~30s each (±20% jitter → 24–36s), NOT the queue's 0/5/15s.
    for (const n of [1, 2, 3, 4]) {
      const d = calculateBackoff(n, 'pos_injection', 'payment_injection');
      const s = (d!.getTime() - now) / 1000;
      expect(s).toBeGreaterThanOrEqual(23);
      expect(s).toBeLessThanOrEqual(37);
    }
  });

  it('unknown job_type falls back to the queue profile', () => {
    const now = Date.now();
    // order_injection has no job_type profile → uses pos_injection[0] = 0s (immediate).
    const d = calculateBackoff(1, 'pos_injection', 'order_injection');
    const s = (d!.getTime() - now) / 1000;
    expect(s).toBeLessThanOrEqual(2);
  });
});
