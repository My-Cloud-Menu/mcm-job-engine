export interface Job {
  id: string;
  site_id: number;
  correlation_id: string;
  queue_name: string;
  job_type: string;
  integration: string;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
  total_steps: number;
  current_step: number;
  reference_type: string | null;
  reference_id: string | null;
}

export interface JobStep {
  id: string;
  job_id: string;
  step_index: number;
  step_name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  idempotency_key: string | null;
  max_attempts: number;
  attempt_count: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  last_error: string | null;
  next_retry_at: string | null;
}

export interface HandlerInput {
  stepInput: Record<string, unknown>;
  jobPayload: Record<string, unknown>;
  context: Record<string, unknown>;
  job: Job;
  step: JobStep;
}

export type Handler = (input: HandlerInput) => Promise<Record<string, unknown>>;

export class HandlerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown,
    // Optional explicit retry delay (e.g. honoring an HTTP `Retry-After` header).
    // When present and the step will retry, the executor uses it for the next
    // attempt instead of the queue backoff profile.
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly integration: string,
    public readonly queue: string
  ) {
    super(`Circuit breaker open for ${integration}/${queue}`);
    this.name = 'CircuitBreakerOpenError';
  }
}
