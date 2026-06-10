import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  env: optional('NODE_ENV', 'development'),

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    dbUrl: required('DATABASE_URL'),
  },

  worker: {
    id: `${process.env['HOSTNAME'] ?? 'local'}-${process.pid}-${Date.now()}`,
    queueName: required('WORKER_QUEUE_NAME'),
    integrations: process.env['WORKER_INTEGRATIONS']
      ? process.env['WORKER_INTEGRATIONS'].split(',').map(s => s.trim())
      : null,
    pollIntervalMs: Number(optional('WORKER_POLL_INTERVAL_MS', '2000')),
    maxConcurrent: Number(optional('WORKER_MAX_CONCURRENT_JOBS', '10')),
    lockSeconds: Number(optional('WORKER_LOCK_DURATION_SECONDS', '180')),
    heartbeatIntervalMs: Number(optional('WORKER_HEARTBEAT_INTERVAL_MS', '60000')),
    port: Number(optional('WORKER_PORT', '3000')),
    runScheduler: optional('RUN_SCHEDULER', 'false') === 'true',
    runAlertDispatcher: optional('RUN_ALERT_DISPATCHER', 'false') === 'true',
  },

  circuitBreaker: {
    threshold: Number(optional('CB_THRESHOLD', '10')),
    windowSeconds: Number(optional('CB_WINDOW_SECONDS', '60')),
    cooldownSeconds: Number(optional('CB_COOLDOWN_SECONDS', '300')),
  },

  posthog: {
    apiKey: optional('POSTHOG_API_KEY', ''),
    host: optional('POSTHOG_HOST', 'https://us.posthog.com'),
    enabled: optional('POSTHOG_API_KEY', '') !== '',
  },

  alerts: {
    resendApiKey: optional('RESEND_API_KEY', ''),
    fromEmail: optional('ALERT_FROM_EMAIL', 'alerts@visionarysoft.com'),
    recipients: optional('ALERT_EMAILS', 'csantos@mycloudmenu.com')
      .split(',')
      .map(s => s.trim()),
    rateLimitPerHour: Number(optional('ALERT_RATE_LIMIT_PER_HOUR', '20')),
    enabled: optional('RESEND_API_KEY', '') !== '',
  },

  logLevel: optional('LOG_LEVEL', 'info'),
};

/** Advisory lock key for scheduler leader election */
export const LEADER_LOCK_KEY = 4815162342;
