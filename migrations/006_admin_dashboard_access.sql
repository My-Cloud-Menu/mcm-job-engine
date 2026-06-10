-- ============================================================
-- 006_admin_dashboard_access.sql
-- Read access for the MCM admin dashboard + admin-gated actions.
--
-- Adds:
--   * mcm_admins allowlist table
--   * is_mcm_super_admin() helper
--   * SELECT policies on all 8 base job-engine tables for super admins
--   * Recreates 7 monitoring views with security_invoker = true so they
--     respect the caller's RLS instead of running as view owner
--   * admin_retry_dead_letter_job / admin_bulk_retry_dead_letters wrappers
-- ============================================================

-- ── allowlist ────────────────────────────────────────────────
create table if not exists public.mcm_admins (
  email      text primary key,
  notes      text,
  created_at timestamptz not null default now()
);

alter table public.mcm_admins enable row level security;

drop policy if exists "admins_can_read_self" on public.mcm_admins;
create policy "admins_can_read_self" on public.mcm_admins
  for select to authenticated
  using ((auth.jwt() ->> 'email') = email);

insert into public.mcm_admins (email, notes) values
  ('prinaldi@mycloudmenu.com',     'Founder'),
  ('csantos@mycloudmenu.com',      'Engineering owner'),
  ('ingcarlosoficial@gmail.com',   'Developer')
on conflict (email) do nothing;

-- ── helper ───────────────────────────────────────────────────
create or replace function public.is_mcm_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.mcm_admins
    where email = (auth.jwt() ->> 'email')
  );
$$;

revoke all on function public.is_mcm_super_admin() from public;
grant execute on function public.is_mcm_super_admin() to authenticated;

-- ── SELECT policies on base tables ───────────────────────────
drop policy if exists "mcm_admin_read" on public.integration_jobs;
create policy "mcm_admin_read" on public.integration_jobs
  for select to authenticated using (public.is_mcm_super_admin());

drop policy if exists "mcm_admin_read" on public.job_steps;
create policy "mcm_admin_read" on public.job_steps
  for select to authenticated using (public.is_mcm_super_admin());

drop policy if exists "mcm_admin_read" on public.job_step_attempts;
create policy "mcm_admin_read" on public.job_step_attempts
  for select to authenticated using (public.is_mcm_super_admin());

drop policy if exists "mcm_admin_read" on public.dead_letter_jobs;
create policy "mcm_admin_read" on public.dead_letter_jobs
  for select to authenticated using (public.is_mcm_super_admin());

drop policy if exists "mcm_admin_read" on public.sync_schedules;
create policy "mcm_admin_read" on public.sync_schedules
  for select to authenticated using (public.is_mcm_super_admin());

drop policy if exists "mcm_admin_read" on public.alerts_outbox;
create policy "mcm_admin_read" on public.alerts_outbox
  for select to authenticated using (public.is_mcm_super_admin());

drop policy if exists "mcm_admin_read" on public.alert_send_log;
create policy "mcm_admin_read" on public.alert_send_log
  for select to authenticated using (public.is_mcm_super_admin());

drop policy if exists "mcm_admin_read" on public.integration_concurrency_limits;
create policy "mcm_admin_read" on public.integration_concurrency_limits
  for select to authenticated using (public.is_mcm_super_admin());

grant select on public.integration_jobs               to authenticated;
grant select on public.job_steps                      to authenticated;
grant select on public.job_step_attempts              to authenticated;
grant select on public.dead_letter_jobs               to authenticated;
grant select on public.sync_schedules                 to authenticated;
grant select on public.alerts_outbox                  to authenticated;
grant select on public.alert_send_log                 to authenticated;
grant select on public.integration_concurrency_limits to authenticated;

-- ── views with security_invoker ──────────────────────────────
create or replace view public.jobs_dashboard
with (security_invoker = true) as
select queue_name, integration, status,
       count(*) as job_count,
       min(created_at) as oldest,
       max(created_at) as newest
from public.integration_jobs
where created_at >= now() - interval '24 hours'
group by queue_name, integration, status
order by queue_name, integration, status;

create or replace view public.jobs_attention_needed
with (security_invoker = true) as
select j.id, j.site_id, j.queue_name, j.integration, j.job_type, j.status,
       j.last_error, j.last_error_at, j.created_at, j.correlation_id,
       j.reference_type, j.reference_id,
       coalesce(dl.reason, j.last_error) as attention_reason
from public.integration_jobs j
left join public.dead_letter_jobs dl on dl.job_id = j.id and dl.resolved_at is null
where j.status in ('dead_letter','retrying')
  and j.created_at >= now() - interval '7 days'
order by j.last_error_at desc nulls last;

create or replace view public.jobs_site_health
with (security_invoker = true) as
select site_id,
       count(*) filter (where status = 'running') as in_flight,
       count(*) filter (where status = 'completed' and completed_at >= now() - interval '24 hours') as completed_24h,
       count(*) filter (where status in ('dead_letter','retrying') and created_at >= now() - interval '24 hours') as failed_24h,
       round(100.0 * count(*) filter (where status = 'completed' and completed_at >= now() - interval '24 hours')
             / nullif(count(*) filter (where created_at >= now() - interval '24 hours' and status in ('completed','dead_letter')), 0), 2) as success_rate_pct
from public.integration_jobs
group by site_id
order by failed_24h desc;

create or replace view public.sync_status
with (security_invoker = true) as
select s.id, s.site_id, s.integration, s.sync_type, s.status,
       s.interval_seconds, s.last_run_at, s.next_run_at, s.last_cursor,
       s.last_error, s.consecutive_failures,
       case
         when s.status = 'disabled' then 'disabled'
         when s.status = 'failing'  then 'failing'
         when s.status = 'paused'   then 'paused'
         when s.next_run_at < now() - (s.interval_seconds * 3 || ' seconds')::interval then 'stale'
         when s.consecutive_failures > 0 then 'degraded'
         else 'healthy'
       end as health
from public.sync_schedules s
order by health desc, s.consecutive_failures desc;

create or replace view public.syncs_attention_needed
with (security_invoker = true) as
select * from public.sync_status
where health in ('failing','disabled','stale','degraded')
order by consecutive_failures desc;

create or replace view public.alerts_pending_view
with (security_invoker = true) as
select id, dedupe_key, severity, event_type, subject, count, site_id,
       integration, first_seen_at, last_seen_at, created_at
from public.alerts_outbox
where status = 'pending'
order by case severity when 'critical' then 1 when 'warning' then 2 else 3 end, created_at asc;

create or replace view public.alerts_recent_view
with (security_invoker = true) as
select id, dedupe_key, severity, event_type, subject, status, count,
       site_id, integration, sent_at, failed_reason, first_seen_at, last_seen_at
from public.alerts_outbox
order by created_at desc
limit 100;

grant select on public.jobs_dashboard          to authenticated;
grant select on public.jobs_attention_needed   to authenticated;
grant select on public.jobs_site_health        to authenticated;
grant select on public.sync_status             to authenticated;
grant select on public.syncs_attention_needed  to authenticated;
grant select on public.alerts_pending_view     to authenticated;
grant select on public.alerts_recent_view      to authenticated;

-- ── admin-gated actions ──────────────────────────────────────
create or replace function public.admin_retry_dead_letter_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text;
begin
  if not public.is_mcm_super_admin() then
    raise exception 'permission denied: not an mcm super admin';
  end if;
  v_actor := coalesce(auth.jwt() ->> 'email', 'admin');
  return public.retry_dead_letter_job(p_job_id, v_actor);
end;
$$;

revoke all on function public.admin_retry_dead_letter_job(uuid) from public;
grant execute on function public.admin_retry_dead_letter_job(uuid) to authenticated;

create or replace function public.admin_bulk_retry_dead_letters(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_mcm_super_admin() then
    raise exception 'permission denied: not an mcm super admin';
  end if;
  return public.bulk_retry_dead_letters(p_filters);
end;
$$;

revoke all on function public.admin_bulk_retry_dead_letters(jsonb) from public;
grant execute on function public.admin_bulk_retry_dead_letters(jsonb) to authenticated;
