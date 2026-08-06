import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We test the module's exported functions by mocking the config and lazy imports
vi.mock('../../src/config', () => ({
  config: {
    circuitBreaker: {
      // El default real es `false` (breaker apagado). Los tests de la máquina de estados
      // necesitan medirla encendida; el caso apagado tiene su propio bloque al final.
      enabled: true,
      threshold: 3,
      windowSeconds: 60,
      cooldownSeconds: 10,
    },
    worker: { id: 'test-worker', queueName: 'test' },
    env: 'test',
    // Sin esto pino aborta la carga del módulo ("default level:undefined") y el fichero entero
    // se saltaba en silencio — estaba así desde antes de este cambio.
    logLevel: 'silent',
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
const { checkCircuit, recordSuccess, recordFailure, getCircuitState, isEnabled } =
  await import('../../src/core/circuit-breaker');
const { config } = await import('../../src/config');

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

  // CB_ENABLED=false es el DEFAULT en producción (2026-08-06): un POS caído no puede detener
  // el sync de nadie, y al volver la integración el sync se retoma solo en el siguiente tick.
  describe('apagado (CB_ENABLED=false)', () => {
    beforeEach(() => {
      config.circuitBreaker.enabled = false;
    });
    afterEach(() => {
      config.circuitBreaker.enabled = true;
    });

    it('isEnabled() refleja la config', () => {
      expect(isEnabled()).toBe(false);
    });

    it('nunca bloquea un job, por muchos fallos que haya', () => {
      const { integration, queue } = freshPair();

      for (let i = 0; i < 50; i++) recordFailure(integration, queue);

      expect(checkCircuit(integration, queue).allowed).toBe(true);
      expect(getCircuitState(integration, queue)).toBe('closed');
    });

    it('no arrastra estado abierto de cuando estaba encendido', () => {
      const { integration, queue } = freshPair();

      config.circuitBreaker.enabled = true;
      for (let i = 0; i < 3; i++) recordFailure(integration, queue);
      expect(checkCircuit(integration, queue).allowed).toBe(false);

      config.circuitBreaker.enabled = false;
      expect(checkCircuit(integration, queue).allowed).toBe(true);
    });
  });
});
