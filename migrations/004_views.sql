-- ============================================================
-- 004_views.sql
-- Operational dashboards and monitoring views
-- ============================================================

-- ── jobs_dashboard ───────────────────────────────────────────
-- Counts per (queue, integration, status) in the last 24 hours
create or replace view jobs_dashboard as
select
  queue_name,
  integration,
  status,
  count(*)           as job_count,
  min(created_at)    as oldest,
  max(created_at)    as newest
from integration_jobs
where created_at >= now() - interval '24 hours'
group by queue_name, integration, status
order by queue_name, integration, status;

-- ── jobs_attention_needed ────────────────────────────────────
-- Jobs in dead_letter or retrying in the last 7 days
create or replace view jobs_attention_needed as
select
  j.id,
  j.site_id,
  j.queue_name,
  j.integration,
  j.job_type,
  j.status,
  j.last_error,
  j.last_error_at,
  j.created_at,
  j.correlation_id,
  j.reference_type,
  j.reference_id,
  coalesce(dl.reason, j.last_error) as attention_reason
from integration_jobs j
left join dead_letter_jobs dl on dl.job_id = j.id and dl.resolved_at is null
where j.status in ('dead_letter', 'retrying')
  and j.created_at >= now() - interval '7 days'
order by j.last_error_at desc nulls last;

-- ── jobs_site_health ─────────────────────────────────────────
-- Per-site health metrics for the last 24 hours
create or replace view jobs_site_health as
select
  site_id,
  count(*) filter (where status = 'running')                        as in_flight,
  count(*) filter (where status = 'completed'
                     and completed_at >= now() - interval '24 hours') as completed_24h,
  count(*) filter (where status in ('dead_letter', 'retrying')
                     and created_at >= now() - interval '24 hours')   as failed_24h,
  round(
    100.0 * count(*) filter (
      where status = 'completed'
        and completed_at >= now() - interval '24 hours'
    ) / nullif(
      count(*) filter (
        where created_at >= now() - interval '24 hours'
          and status in ('completed', 'dead_letter')
      ), 0
    ), 2
  ) as success_rate_pct
from integration_jobs
group by site_id
order by failed_24h desc;

-- ── sync_status ──────────────────────────────────────────────
-- Current state of all sync schedules with calculated health
create or replace view sync_status as
select
  s.id,
  s.site_id,
  s.integration,
  s.sync_type,
  s.status,
  s.interval_seconds,
  s.last_run_at,
  s.next_run_at,
  s.last_cursor,
  s.last_error,
  s.consecutive_failures,
  case
    when s.status = 'disabled' then 'disabled'
    when s.status = 'failing'  then 'failing'
    when s.status = 'paused'   then 'paused'
    when s.next_run_at < now() - (s.interval_seconds * 3 || ' seconds')::interval then 'stale'
    when s.consecutive_failures > 0 then 'degraded'
    else 'healthy'
  end as health
from sync_schedules s
order by health desc, s.consecutive_failures desc;

-- ── syncs_attention_needed ───────────────────────────────────
-- Syncs that are failing, disabled, or stale
create or replace view syncs_attention_needed as
select *
from sync_status
where health in ('failing', 'disabled', 'stale', 'degraded')
order by consecutive_failures desc;

-- ── alerts_pending_view ──────────────────────────────────────
-- Alerts waiting to be sent
create or replace view alerts_pending_view as
select
  id,
  dedupe_key,
  severity,
  event_type,
  subject,
  count,
  site_id,
  integration,
  first_seen_at,
  last_seen_at,
  created_at
from alerts_outbox
where status = 'pending'
order by
  case severity when 'critical' then 1 when 'warning' then 2 else 3 end,
  created_at asc;

-- ── alerts_recent_view ───────────────────────────────────────
-- Last 100 alerts with summary (all statuses)
create or replace view alerts_recent_view as
select
  id,
  dedupe_key,
  severity,
  event_type,
  subject,
  status,
  count,
  site_id,
  integration,
  sent_at,
  failed_reason,
  first_seen_at,
  last_seen_at
from alerts_outbox
order by created_at desc
limit 100;
