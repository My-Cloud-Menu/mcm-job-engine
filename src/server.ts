import express from 'express';
import { config } from './config';
import { logger } from './lib/logger';
import { getAllCircuitStates } from './core/circuit-breaker';

interface WorkerStatus {
  active_jobs: number;
  healthy: boolean;
  queue: string;
  worker_id: string;
  is_scheduler: boolean;
  is_alert_dispatcher: boolean;
}

export function startServer(getStatus: () => WorkerStatus): void {
  const app = express();

  app.get('/health', (_req, res) => {
    const status = getStatus();
    const statusCode = status.healthy ? 200 : 503;

    res.status(statusCode).json({
      status: status.healthy ? 'ok' : 'stopping',
      ...status,
    });
  });

  app.get('/', (_req, res) => {
    const status = getStatus();
    res.json({
      service: 'mcm-job-engine',
      version: process.env['npm_package_version'] ?? 'unknown',
      env: config.env,
      ...status,
      circuit_breakers: getAllCircuitStates(),
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  app.listen(config.worker.port, () => {
    logger.info({ port: config.worker.port }, 'health server listening');
  });
}
