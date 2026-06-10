import { describe, it, expect, beforeEach, vi } from 'vitest';

// We test the module's exported functions by mocking the config and lazy imports
vi.mock('../../src/config', () => ({
  config: {
    circuitBreaker: {
      threshold: 3,
      windowSeconds: 60,
      cooldownSeconds: 10,
    },
    worker: { id: 'test-worker', queueName: 'test' },
    env: 'test',
  },
}));

// Mock lazy-imported alert/posthog to prevent side effects
vi.mock('../../src/observability/alerts/index', () => ({
  enqueueAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/observability/posthog', () => ({
  trackEvent: vi.fn(),
}));

// Re-import after mocks are set up
const { checkCircuit, recordSuccess, recordFailure, getCircuitState } =
  await import('../../src/core/circuit-breaker');

describe('circuit-breaker', () => {
  // Each test uses unique integration names to avoid state pollution
  let counter = 0;
  function freshPair() {
    counter++;
    return { integration: `integ_${counter}`, queue: `queue_${counter}` };
  }

  it('starts in closed state', () => {
    const { integration, queue } = freshPair();
    expect(getCircuitState(integration, queue)).toBe('closed');
    expect(checkCircuit(integration, queue).allowed).toBe(true);
  });

  it('transitions closed → open after threshold failures', () => {
    const { integration, queue } = freshPair();

    recordFailure(integration, queue);
    expect(getCircuitState(integration, queue)).toBe('closed');

    recordFailure(integration, queue);
    expect(getCircuitState(integration, queue)).toBe('closed');

    recordFailure(integration, queue); // reaches threshold=3
    expect(getCircuitState(integration, queue)).toBe('open');
    expect(checkCircuit(integration, queue).allowed).toBe(false);
  });

  it('transitions open → half_open after cooldown', () => {
    vi.useFakeTimers();

    const { integration, queue } = freshPair();

    for (let i = 0; i < 3; i++) recordFailure(integration, queue);
    expect(getCircuitState(integration, queue)).toBe('open');

    // Advance past cooldownSeconds (10s in test config)
    vi.advanceTimersByTime(11_000);

    const check = checkCircuit(integration, queue);
    expect(check.allowed).toBe(true);
    expect(getCircuitState(integration, queue)).toBe('half_open');

    vi.useRealTimers();
  });

  it('transitions half_open → closed on success', () => {
    vi.useFakeTimers();

    const { integration, queue } = freshPair();

    for (let i = 0; i < 3; i++) recordFailure(integration, queue);
    vi.advanceTimersByTime(11_000);
    checkCircuit(integration, queue); // triggers → half_open

    recordSuccess(integration, queue);
    expect(getCircuitState(integration, queue)).toBe('closed');
    expect(checkCircuit(integration, queue).allowed).toBe(true);

    vi.useRealTimers();
  });

  it('transitions half_open → open on failure', () => {
    vi.useFakeTimers();

    const { integration, queue } = freshPair();

    for (let i = 0; i < 3; i++) recordFailure(integration, queue);
    vi.advanceTimersByTime(11_000);
    checkCircuit(integration, queue); // → half_open

    recordFailure(integration, queue); // test request fails
    expect(getCircuitState(integration, queue)).toBe('open');
    expect(checkCircuit(integration, queue).allowed).toBe(false);

    vi.useRealTimers();
  });

  it('success in closed state resets failure list', () => {
    const { integration, queue } = freshPair();

    recordFailure(integration, queue);
    recordFailure(integration, queue);
    recordSuccess(integration, queue);

    // One more failure should not open the circuit (counter reset)
    recordFailure(integration, queue);
    expect(getCircuitState(integration, queue)).toBe('closed');
  });
});
