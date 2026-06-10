import { supabase } from '../lib/supabase';
import { logger, withCorrelation } from '../lib/logger';
import { sanitizePayload } from '../lib/sanitize';
import { config } from '../config';
import { Job, JobStep } from './types';
import { getJobSteps, releaseJobLock } from './claim';
import { getHandler } from '../handlers/registry';
import { classifyError } from './error-classifier';
import { calculateBackoff } from './backoff';
import { startHeartbeat } from './heartbeat';
import { checkCircuit, recordSuccess, recordFailure } from './circuit-breaker';
import { trackEvent } from '../observability/posthog';

export async function executeJob(job: Job): Promise<void> {
  const log = withCorrelation(job.correlation_id).child({
    job_id: job.id,
    site_id: job.site_id,
    integration: job.integration,
    queue: job.queue_name,
  });

  log.info({ job_type: job.job_type }, 'processing job');
  trackEvent('job_started', {
    job_id: job.id,
    site_id: job.site_id,
    integration: job.integration,
    queue: job.queue_name,
    correlation_id: job.correlation_id,
  });

  // Check circuit breaker before taking the job
  const cb = checkCircuit(job.integration, job.queue_name);
  if (!cb.allowed) {
    log.warn({ reason: cb.reason }, 'circuit breaker blocking job');

    const retryAt = new Date(Date.now() + config.circuitBreaker.cooldownSeconds * 1000);
    await supabase
      .from('integration_jobs')
      .update({
        status: 'retrying',
        scheduled_for: retryAt.toISOString(),
        locked_by: null,
        locked_until: null,
        last_error: `Circuit breaker open: ${cb.reason}`,
        last_error_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    trackEvent('job_blocked_by_circuit_breaker', {
      job_id: job.id,
      integration: job.integration,
      queue: job.queue_name,
    });
    return;
  }

  const heartbeat = startHeartbeat(job.id, job.correlation_id);

  try {
    const steps = await getJobSteps(job.id);

    for (const step of steps) {
      if (step.status === 'completed') continue;

      const result = await executeStep(job, step, log);
      if (result === 'failed_retry' || result === 'failed_dead') return;
    }

    log.info('job completed');
    trackEvent('job_completed', {
      job_id: job.id,
      site_id: job.site_id,
      integration: job.integration,
      queue: job.queue_name,
      correlation_id: job.correlation_id,
    });
  } catch (err) {
    log.error({ err }, 'unexpected executor error');
    await releaseJobLock(job.id);
  } finally {
    heartbeat.stop();
  }
}

type StepResult = 'completed' | 'failed_retry' | 'failed_dead';

async function executeStep(
  job: Job,
  step: JobStep,
  log: ReturnType<typeof withCorrelation>
): Promise<StepResult> {
  const stepLog = log.child({
    step_name: step.step_name,
    step_index: step.step_index,
  });

  stepLog.info({ attempt: step.attempt_count + 1 }, 'executing step');

  // Re-fetch context so we always see outputs from previous steps
  const { data: freshJob } = await supabase
    .from('integration_jobs')
    .select('context, payload')
    .eq('id', job.id)
    .single();

  const context = (freshJob?.context ?? {}) as Record<string, unknown>;
  const jobPayload = (freshJob?.payload ?? job.payload) as Record<string, unknown>;
  const stepInput = (step.input ?? {}) as Record<string, unknown>;

  const handler = getHandler(job.integration, step.step_name);
  if (!handler) {
    const errMsg = `No handler registered for ${job.integration}.${step.step_name}`;
    stepLog.error(errMsg);
    await failStep(step, errMsg, null);
    return 'failed_dead';
  }

  const attemptNumber = step.attempt_count + 1;
  const startTime = Date.now();

  try {
    const output = await handler({ stepInput, jobPayload, context, job, step });
    const durationMs = Date.now() - startTime;

    await supabase.from('job_step_attempts').insert({
      step_id: step.id,
      job_id: job.id,
      site_id: job.site_id,
      attempt_number: attemptNumber,
      request_payload: sanitizePayload(stepInput),
      response_body: sanitizePayload(output),
      success: true,
      duration_ms: durationMs,
      worker_id: config.worker.id,
    });

    await supabase.rpc('complete_step', {
      p_step_id: step.id,
      p_output: output,
    });

    recordSuccess(job.integration, job.queue_name);

    stepLog.info({ duration_ms: durationMs }, 'step completed');
    trackEvent('step_completed', {
      job_id: job.id,
      step_name: step.step_name,
      integration: job.integration,
      duration_ms: durationMs,
      correlation_id: job.correlation_id,
    });

    return 'completed';

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const classified = classifyError(err);

    stepLog.warn({
      err_message: classified.message,
      err_code: classified.code,
      retryable: classified.retryable,
    }, 'step failed');

    await supabase.from('job_step_attempts').insert({
      step_id: step.id,
      job_id: job.id,
      site_id: job.site_id,
      attempt_number: attemptNumber,
      request_payload: sanitizePayload(stepInput),
      response_status: classified.statusCode ?? null,
      response_body: sanitizePayload(classified.responseBody),
      success: false,
      error_message: classified.message,
      error_code: classified.code,
      is_retryable: classified.retryable,
      duration_ms: durationMs,
      worker_id: config.worker.id,
    });

    if (classified.retryable) {
      recordFailure(job.integration, job.queue_name);
    }

    const willRetry = classified.retryable && attemptNumber < step.max_attempts;
    // Honor an explicit retry hint (e.g. HTTP `Retry-After`) over the queue
    // backoff profile when the handler provided one.
    const nextRetryAt = willRetry
      ? classified.retryAfterSeconds != null
        ? new Date(Date.now() + classified.retryAfterSeconds * 1000)
        : calculateBackoff(attemptNumber, job.queue_name)
      : null;

    await failStep(step, classified.message, nextRetryAt);

    trackEvent('step_failed', {
      job_id: job.id,
      step_name: step.step_name,
      integration: job.integration,
      err_code: classified.code,
      retryable: classified.retryable,
      will_retry: willRetry,
      correlation_id: job.correlation_id,
    });

    return willRetry ? 'failed_retry' : 'failed_dead';
  }
}

async function failStep(
  step: JobStep,
  error: string,
  nextRetryAt: Date | null
): Promise<void> {
  await supabase.rpc('fail_step', {
    p_step_id: step.id,
    p_error: error,
    p_next_retry_at: nextRetryAt?.toISOString() ?? null,
  });
}
