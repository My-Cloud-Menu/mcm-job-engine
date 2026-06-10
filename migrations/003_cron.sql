-- ============================================================
-- 003_cron.sql
-- pg_cron scheduled jobs for maintenance and recovery
-- ============================================================

create extension if not exists pg_cron;

-- Recover stuck running jobs every minute
select cron.schedule(
  'recover-stuck-jobs',
  '* * * * *',
  $$ select recover_stuck_jobs() $$
);

-- Clean up old step attempts (keep 30 days for completed jobs)
select cron.schedule(
  'cleanup-old-attempts',
  '0 3 * * *',
  $$
    delete from job_step_attempts
    where created_at < now() - interval '30 days'
      and job_id in (
        select id from integration_jobs
        where status = 'completed'
          and completed_at < now() - interval '30 days'
      )
  $$
);

-- Clean up sent/suppressed alerts older than 30 days
select cron.schedule(
  'cleanup-old-alerts',
  '0 4 * * *',
  $$
    delete from alerts_outbox
    where status in ('sent', 'suppressed')
      and updated_at < now() - interval '30 days'
  $$
);

-- Clean up alert send log older than 7 days
select cron.schedule(
  'cleanup-alert-log',
  '0 5 * * *',
  $$
    delete from alert_send_log
    where sent_at < now() - interval '7 days'
  $$
);
