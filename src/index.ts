import { config } from './config';
import { logger } from './lib/logger';
import { claimNextJob } from './core/claim';
import { executeJob } from './core/executor';
import { PgListener } from './lib/pg-listener';
import { startServer } from './server';
import { startScheduler, stopScheduler } from './scheduler';
import { startAlertDispatcher, stopAlertDispatcher } from './observability/alerts/dispatcher';
import { trackEvent, shutdown as posthogShutdown } from './observability/posthog';
import { releaseLeaderLock } from './scheduler/leader-lock';

// Eagerly register all handlers
import './handlers/load-handlers';

let running = true;
let activeJobs = 0;
let immediatePoll = false;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function workerLoop(): Promise<void> {
  const listener = new PgListener();
  const channel = `jobs_${config.worker.queueName}`;

  try {
    await listener.connect();
    await listener.listen(channel, () => { immediatePoll = true; });
    logger.info({ channel }, 'pg-listener subscribed');
  } catch (err) {
    logger.warn({ err }, 'pg-listener failed, polling-only mode');
  }

  logger.info({
    worker_id: config.worker.id,
    queue: config.worker.queueName,
    max_concurrent: config.worker.maxConcurrent,
  }, 'worker started');

  trackEvent('worker_started', {
    queue: config.worker.queueName,
    integrations: config.worker.integrations,
  });

  while (running) {
    try {
      if (activeJobs >= config.worker.maxConcurrent) {
        await sleep(200);
        continue;
      }

      const job = await claimNextJob();

      if (!job) {
        // Wait for NOTIFY or poll interval, whichever comes first
        const start = Date.now();
        while (running && !immediatePoll && Date.now() - start < config.worker.pollIntervalMs) {
          await sleep(100);
        }
        immediatePoll = false;
        continue;
      }

      activeJobs++;
      executeJob(job)
        .catch(err => logger.error({ err, job_id: job.id }, 'unhandled job error'))
        .finally(() => { activeJobs--; });

    } catch (err) {
      logger.error({ err }, 'worker loop error');
      await sleep(5_000);
    }
  }

  logger.info('draining active jobs...');
  while (activeJobs > 0) {
    logger.info({ activeJobs }, 'waiting for in-flight jobs');
    await sleep(1_000);
  }

  await listener.close();
  await releaseLeaderLock();
  trackEvent('worker_stopped');
  await posthogShutdown();

  logger.info('worker stopped cleanly');
  process.exit(0);
}

// Scheduler (only one replica should have RUN_SCHEDULER=true)
if (config.worker.runScheduler) {
  startScheduler().catch(err => logger.error({ err }, 'scheduler crashed'));
}

// Alert dispatcher (only one replica should have RUN_ALERT_DISPATCHER=true)
if (config.worker.runAlertDispatcher) {
  startAlertDispatcher().catch(err => logger.error({ err }, 'alert dispatcher crashed'));
}

startServer(() => ({
  active_jobs: activeJobs,
  healthy: running,
  queue: config.worker.queueName,
  worker_id: config.worker.id,
  is_scheduler: config.worker.runScheduler,
  is_alert_dispatcher: config.worker.runAlertDispatcher,
}));

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — initiating graceful shutdown');
  running = false;
  stopScheduler();
  stopAlertDispatcher();
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — initiating graceful shutdown');
  running = false;
  stopScheduler();
  stopAlertDispatcher();
});

workerLoop().catch(err => {
  logger.fatal({ err }, 'worker loop fatal error');
  process.exit(1);
});
