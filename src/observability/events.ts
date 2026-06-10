export const Events = {
  JOB_STARTED: 'job_started',
  JOB_COMPLETED: 'job_completed',
  JOB_DEAD_LETTER: 'job_dead_letter',
  JOB_BLOCKED_BY_CIRCUIT_BREAKER: 'job_blocked_by_circuit_breaker',

  STEP_COMPLETED: 'step_completed',
  STEP_FAILED: 'step_failed',

  SYNC_COMPLETED: 'sync_completed',
  SYNC_FAILED: 'sync_failed',

  CIRCUIT_BREAKER_OPENED: 'circuit_breaker_opened',
  CIRCUIT_BREAKER_CLOSED: 'circuit_breaker_closed',

  WORKER_STARTED: 'worker_started',
  WORKER_STOPPED: 'worker_stopped',

  ALERT_SENT: 'alert_sent',
  ALERT_SUPPRESSED: 'alert_suppressed',
} as const;

export type EventName = (typeof Events)[keyof typeof Events];
