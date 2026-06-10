-- ============================================================
-- 015_requeue_job.sql
-- Manual requeue of a terminal job from the /admin/jobs dashboard, with an
-- OPTIONAL payload override (edit-payload-and-retry).
--
-- Generalises `retry_dead_letter_job` (002) beyond dead_letter:
--   * `requeue_job(job_id, actor, payload_override?)` — core logic
--   * `admin_requeue_job(job_id, payload_override?)` — admin-gated wrapper,
--     mirroring `admin_retry_dead_letter_job` (006): is_mcm_super_admin() check,
--     actor from the JWT, revoke from public / grant to authenticated.
--
-- The `tg_jobs_notify` trigger (001) re-notifies the worker on status→pending,
-- so no explicit pg_notify is needed.
-- ============================================================

create or replace function requeue_job(
  p_job_id           uuid,
  p_actor            text  default 'manual',
  p_payload_override jsonb default null
) returns boolean language plpgsql as $$
declare
  v_status     text;
  v_full_reset bool;
begin
  select status into v_status from integration_jobs where id = p_job_id;
  if v_status is null then return false; end if;

  -- Only terminal jobs may be requeued — never an in-flight one (would race the
  -- worker / double-run a step).
  if v_status not in ('failed', 'dead_letter', 'completed', 'cancelled') then
    raise exception
      'job %: status "%" is not terminal (only failed/dead_letter/completed/cancelled can be requeued)',
      p_job_id, v_status;
  end if;

  -- A payload edit, or re-running a completed job, requires a FULL re-run (reset
  -- EVERY step incl. completed ones). A plain retry of a failed/dead_letter job
  -- resumes (reset only the non-completed steps), mirroring retry_dead_letter_job.
  v_full_reset := (p_payload_override is not null) or (v_status = 'completed');

  if v_full_reset then
    update job_steps
    set status        = 'pending',
        attempt_count = 0,
        last_error    = null,
        next_retry_at = null,
        output        = null,
        completed_at  = null,
        updated_at    = now()
    where job_id = p_job_id;
  else
    update job_steps
    set status        = 'pending',
        attempt_count = 0,
        last_error    = null,
        next_retry_at = null,
        updated_at    = now()
    where job_id = p_job_id
      and status != 'completed';
  end if;

  update integration_jobs
  set status            = 'pending',
      payload           = coalesce(p_payload_override, payload),
      context           = case when v_full_reset then '{}'::jsonb else context end,
      current_step      = case when v_full_reset then 0    else current_step end,
      current_step_name = case when v_full_reset then null else current_step_name end,
      last_error        = null,
      last_error_at     = null,
      locked_by         = null,
      locked_until      = null,
      completed_at      = null,
      scheduled_for     = now(),
      updated_at        = now()
  where id = p_job_id;

  -- Resolve any open dead-letter entry.
  update dead_letter_jobs
  set resolved_at      = now(),
      resolved_by      = p_actor,
      resolution_notes = case
                           when p_payload_override is not null then 'Manual requeue (payload edited)'
                           else 'Manual requeue'
                         end
  where job_id = p_job_id
    and resolved_at is null;

  return true;
end;
$$;

-- ── admin-gated wrapper ──────────────────────────────────────
create or replace function public.admin_requeue_job(
  p_job_id           uuid,
  p_payload_override jsonb default null
) returns boolean
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
  return public.requeue_job(p_job_id, v_actor, p_payload_override);
end;
$$;

revoke all on function public.admin_requeue_job(uuid, jsonb) from public;
grant execute on function public.admin_requeue_job(uuid, jsonb) to authenticated;
