import { config } from '../config';
import { logger } from '../lib/logger';

type State = 'closed' | 'open' | 'half_open';

interface BreakerState {
  state: State;
  failures: { timestamp: number }[];
  openedAt?: number;
  lastTestAt?: number;
}

// In-memory state — one per (integration, queue) pair per worker process
const breakers = new Map<string, BreakerState>();

function key(integration: string, queue: string): string {
  return `${integration}:${queue}`;
}

function getOrCreate(integration: string, queue: string): BreakerState {
  const k = key(integration, queue);
  let state = breakers.get(k);
  if (!state) {
    state = { state: 'closed', failures: [] };
    breakers.set(k, state);
  }
  return state;
}

export function checkCircuit(
  integration: string,
  queue: string
): { allowed: boolean; reason?: string } {
  const breaker = getOrCreate(integration, queue);
  const now = Date.now();

  if (breaker.state === 'open') {
    const cooldownMs = config.circuitBreaker.cooldownSeconds * 1000;
    if (breaker.openedAt !== undefined && now - breaker.openedAt >= cooldownMs) {
      breaker.state = 'half_open';
      breaker.lastTestAt = now;
      logger.info({ integration, queue }, 'circuit breaker → half_open');
      return { allowed: true };
    }
    return { allowed: false, reason: 'circuit_open' };
  }

  if (breaker.state === 'half_open') {
    if (breaker.lastTestAt !== undefined && now - breaker.lastTestAt < 5_000) {
      return { allowed: false, reason: 'half_open_throttled' };
    }
    breaker.lastTestAt = now;
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordSuccess(integration: string, queue: string): void {
  const breaker = getOrCreate(integration, queue);

  if (breaker.state === 'half_open') {
    breaker.state = 'closed';
    breaker.failures = [];
    delete breaker.openedAt;
    logger.info({ integration, queue }, 'circuit breaker → closed (recovered)');

    // Fire alert asynchronously — imported lazily to avoid circular dep
    import('../observability/alerts/index').then(({ enqueueAlert }) =>
      enqueueAlert({
        dedupeKey: `cb_recovered:${integration}:${queue}`,
        severity: 'info',
        eventType: 'circuit_breaker_closed',
        subject: `[INFO] Circuit breaker recovered: ${integration}`,
        body: `The circuit breaker for ${integration}/${queue} has recovered and is now closed.`,
        metadata: { integration, queue },
        integration,
      })
    ).catch(err => logger.error({ err }, 'failed to enqueue recovery alert'));

    import('../observability/posthog').then(({ trackEvent }) =>
      trackEvent('circuit_breaker_closed', { integration, queue })
    ).catch(() => {});

  } else if (breaker.state === 'closed') {
    breaker.failures = [];
  }
}

export function recordFailure(integration: string, queue: string): void {
  const breaker = getOrCreate(integration, queue);
  const now = Date.now();
  const windowMs = config.circuitBreaker.windowSeconds * 1000;

  // Evict failures outside the sliding window
  breaker.failures = breaker.failures.filter(f => now - f.timestamp < windowMs);
  breaker.failures.push({ timestamp: now });

  if (breaker.state === 'half_open') {
    breaker.state = 'open';
    breaker.openedAt = now;
    logger.warn({ integration, queue }, 'circuit breaker → open (half_open test failed)');
    return;
  }

  if (breaker.state === 'closed' && breaker.failures.length >= config.circuitBreaker.threshold) {
    breaker.state = 'open';
    breaker.openedAt = now;

    logger.warn({ integration, queue, failures: breaker.failures.length }, 'circuit breaker → open');

    import('../observability/alerts/index').then(({ enqueueAlert }) =>
      enqueueAlert({
        dedupeKey: `cb_open:${integration}:${queue}`,
        severity: 'critical',
        eventType: 'circuit_breaker_open',
        subject: `[URGENT] Circuit breaker opened: ${integration}`,
        body: `The circuit breaker for ${integration}/${queue} opened after ${breaker.failures.length} failures `
          + `in ${config.circuitBreaker.windowSeconds}s. Cooldown: ${config.circuitBreaker.cooldownSeconds}s.`,
        metadata: { integration, queue, failures: breaker.failures.length },
        integration,
      })
    ).catch(err => logger.error({ err }, 'failed to enqueue cb alert'));

    import('../observability/posthog').then(({ trackEvent }) =>
      trackEvent('circuit_breaker_opened', {
        integration,
        queue,
        failures: breaker.failures.length,
      })
    ).catch(() => {});
  }
}

export function getCircuitState(integration: string, queue: string): State {
  return getOrCreate(integration, queue).state;
}

export function getAllCircuitStates(): Record<string, State> {
  const result: Record<string, State> = {};
  for (const [k, v] of breakers) {
    result[k] = v.state;
  }
  return result;
}
