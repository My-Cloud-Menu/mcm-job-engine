import { supabase } from '../lib/supabase';
import { logger } from '../lib/logger';
import { config } from '../config';

export interface HeartbeatHandle {
  stop: () => void;
}

/**
 * Starts a background interval that extends the job lock every
 * heartbeatIntervalMs milliseconds. If the lock is no longer owned
 * by this worker (e.g. recovered by pg_cron), stops silently.
 */
export function startHeartbeat(
  jobId: string,
  correlationId: string
): HeartbeatHandle {
  let stopped = false;

  const interval = setInterval(async () => {
    if (stopped) return;

    try {
      const { data, error } = await supabase.rpc('heartbeat_job', {
        p_job_id: jobId,
        p_worker_id: config.worker.id,
        p_extend_seconds: config.worker.lockSeconds,
      });

      if (error) {
        logger.error(
          { err: error, jobId, correlation_id: correlationId },
          'heartbeat failed'
        );
        return;
      }

      if (data === false || data === null) {
        logger.warn(
          { jobId, correlation_id: correlationId },
          'heartbeat: lost lock — another worker took over'
        );
        stopped = true;
        clearInterval(interval);
      }
    } catch (err) {
      logger.error({ err, jobId, correlation_id: correlationId }, 'heartbeat threw');
    }
  }, config.worker.heartbeatIntervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
