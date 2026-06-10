-- ============================================================
-- 002_jobs_functions.sql
-- Stored procedures for job lifecycle management
-- ============================================================

-- ── enqueue_job ─────────────────────────────────────────────
create or replace function enqueue_job(
  p_site_id         bigint,
  p_queue_name      text,
  p_job_type        text,
  p_integration     text,
  p_idempotency_key text,
  p_payload         jsonb,
  p_total_steps     int,
  p_steps           jsonb,           -- array of {step_name, max_attempts, input, idempotency_key?}
  p_priority        int default 5,
  p_scheduled_for   timestamptz default now(),
  p_reference_type  text default null,
  p_reference_id    text default null,
  p_correlation_id  uuid default null
) returns uuid language plpgsql as $$
declare
  v_job_id uuid;
  v_step   jsonb;
  v_idx    int := 0;
begin
  insert into integration_jobs (
    site_id, queue_name, job_type, integration, idempotency_key,
    payload, total_steps, priority, scheduled_for,
    reference_type, reference_id, correlation_id
  ) values (
    p_site_id, p_queue_name, p_job_type, p_integration, p_idempotency_key,
    p_payload, p_total_steps, p_priority, p_scheduled_for,
    p_reference_type, p_reference_id,
    coalesce(p_correlation_id, gen_random_uuid())
  )
  on conflict (idempotency_key) do nothing
  returning id into v_job_id;

  -- If conflict, return existing job id
  if v_job_id is null then
    select id into v_job_id
    from integration_jobs
    where idempotency_key = p_idempotency_key;
    return v_job_id;
  end if;

  for v_step in select * from jsonb_array_elements(p_steps)
  loop
    insert into job_steps (
      job_id, step_index, step_name, max_attempts, input, idempotency_key
    ) values (
      v_job_id,
      v_idx,
      v_step->>'step_name',
      coalesce((v_step->>'max_attempts')::int, 3),
      v_step->'input',
      v_step->>'idempotency_key'
    );
    v_idx := v_idx + 1;
  end loop;

  return v_job_id;
end;
$$;

-- ── claim_next_job ──────────────────────────────────────────
create or replace function claim_next_job(
  p_worker_id    text,
  p_queue_name   text,
  p_lock_seconds int default 180,
  p_integrations text[] default null
) returns table (
  id              uuid,
  site_id         bigint,
  correlation_id  uuid,
  queue_name      text,
  job_type        text,
  integration     text,
  payload         jsonb,
  context         jsonb,
  total_steps     int,
  current_step    int,
  reference_type  text,
  reference_id    text
) language plpgsql as $$
declare
  v_job_id uuid;
begin
  -- Enforce concurrency limits per integration and per site
  select j.id into v_job_id
  from integration_jobs j
  where j.queue_name = p_queue_name
    and j.status in ('pending', 'retrying')
    and j.scheduled_for <= now()
    and (p_integrations is null or j.integration = any(p_integrations))
    -- Per-integration global limit
    and (
      not exists (
        select 1 from integration_concurrency_limits l
        where l.enabled
          and l.queue_name is null
          and l.site_id is null
          and l.integration = j.integration
          and (
            select count(*) from integration_jobs r
            where r.integration = j.integration
              and r.status = 'running'
          ) >= l.max_concurrency
      )
    )
    -- Per-site limit
    and (
      not exists (
        select 1 from integration_concurrency_limits l
        where l.enabled
          and l.site_id = j.site_id
          and (
            select count(*) from integration_jobs r
            where r.site_id = j.site_id
              and r.status = 'running'
          ) >= l.max_concurrency
      )
    )
  order by j.priority desc, j.scheduled_for asc
  limit 1
  for update skip locked;

  if v_job_id is null then
    return;
  end if;

  -- Use table alias so RETURNING columns are unambiguous vs OUT parameter names
  update integration_jobs as j
  set status       = 'running',
      locked_by    = p_worker_id,
      locked_until = now() + (p_lock_seconds || ' seconds')::interval,
      updated_at   = now()
  where j.id = v_job_id
  returning
    j.id, j.site_id, j.correlation_id, j.queue_name, j.job_type, j.integration,
    j.payload, j.context, j.total_steps, j.current_step, j.reference_type, j.reference_id
  into
    id, site_id, correlation_id, queue_name, job_type, integration,
    payload, context, total_steps, current_step, reference_type, reference_id;

  return next;
end;
$$;

-- ── heartbeat_job ────────────────────────────────────────────
create or replace function heartbeat_job(
  p_job_id        uuid,
  p_worker_id     text,
  p_extend_seconds int default 180
) returns boolean language plpgsql as $$
declare
  v_updated int;
begin
  update integration_jobs
  set locked_until = now() + (p_extend_seconds || ' seconds')::interval,
      updated_at   = now()
  where id = p_job_id
    and locked_by = p_worker_id
    and status = 'running';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ── complete_step ────────────────────────────────────────────
create or replace function complete_step(
  p_step_id uuid,
  p_output  jsonb default '{}'::jsonb
) returns void language plpgsql as $$
declare
  v_job_id    uuid;
  v_step_name text;
  v_step_idx  int;
  v_total     int;
begin
  update job_steps
  set status       = 'completed',
      output       = p_output,
      attempt_count = attempt_count + 1,
      completed_at = now(),
      updated_at   = now()
  where id = p_step_id
  returning job_id, step_name, step_index into v_job_id, v_step_name, v_step_idx;

  -- Merge step output into job context under step_name key
  update integration_jobs
  set context          = jsonb_set(context, array[v_step_name], p_output, true),
      current_step     = v_step_idx + 1,
      current_step_name = v_step_name,
      updated_at       = now()
  where id = v_job_id
  returning total_steps into v_total;

  -- If all steps done, mark job completed
  if (v_step_idx + 1) >= v_total then
    update integration_jobs
    set status       = 'completed',
        locked_by    = null,
        locked_until = null,
        completed_at = now(),
        updated_at   = now()
    where id = v_job_id
      and status = 'running';
  end if;
end;
$$;

-- ── fail_step ────────────────────────────────────────────────
create or replace function fail_step(
  p_step_id      uuid,
  p_error        text,
  p_next_retry_at timestamptz default null
) returns void language plpgsql as $$
declare
  v_job_id        uuid;
  v_attempt_count int;
  v_max_attempts  int;
begin
  update job_steps
  set last_error    = p_error,
      attempt_count = attempt_count + 1,
      next_retry_at = p_next_retry_at,
      updated_at    = now()
  where id = p_step_id
  returning job_id, attempt_count, max_attempts
    into v_job_id, v_attempt_count, v_max_attempts;

  if p_next_retry_at is not null then
    -- Will retry: mark step as pending, job as retrying
    update job_steps
    set status = 'pending'
    where id = p_step_id;

    update integration_jobs
    set status        = 'retrying',
        last_error    = p_error,
        last_error_at = now(),
        locked_by     = null,
        locked_until  = null,
        scheduled_for = p_next_retry_at,
        updated_at    = now()
    where id = v_job_id;
  else
    -- No more retries: mark step failed, job dead_letter
    update job_steps
    set status = 'failed'
    where id = p_step_id;

    update integration_jobs
    set status        = 'dead_letter',
        last_error    = p_error,
        last_error_at = now(),
        locked_by     = null,
        locked_until  = null,
        updated_at    = now()
    where id = v_job_id;

    -- Insert into dead_letter_jobs (trigger will fire alert)
    insert into dead_letter_jobs (job_id, site_id, reason)
    select id, site_id, p_error
    from integration_jobs
    where id = v_job_id;
  end if;
end;
$$;

-- ── release_job_lock ─────────────────────────────────────────
create or replace function release_job_lock(p_job_id uuid)
returns void language plpgsql as $$
begin
  update integration_jobs
  set locked_by    = null,
      locked_until = null,
      status       = case when status = 'running' then 'pending' else status end,
      updated_at   = now()
  where id = p_job_id;
end;
$$;

-- ── recover_stuck_jobs ───────────────────────────────────────
-- Called by pg_cron every minute
create or replace function recover_stuck_jobs()
returns int language plpgsql as $$
declare
  v_count int;
begin
  update integration_jobs
  set status        = 'retrying',
      locked_by     = null,
      locked_until  = null,
      scheduled_for = now(),
      last_error    = 'Recovered from stuck running state (lock expired)',
      last_error_at = now(),
      updated_at    = now()
  where status = 'running'
    and locked_until < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── retry_dead_letter_job ────────────────────────────────────
create or replace function retry_dead_letter_job(
  p_job_id   uuid,
  p_actor    text default 'manual'
) returns boolean language plpgsql as $$
declare
  v_exists bool;
begin
  select exists(
    select 1 from integration_jobs where id = p_job_id and status = 'dead_letter'
  ) into v_exists;

  if not v_exists then return false; end if;

  -- Reset non-completed steps
  update job_steps
  set status        = 'pending',
      attempt_count = 0,
      last_error    = null,
      next_retry_at = null,
      updated_at    = now()
  where job_id = p_job_id
    and status != 'completed';

  -- Reset job
  update integration_jobs
  set status        = 'pending',
      last_error    = null,
      last_error_at = null,
      locked_by     = null,
      locked_until  = null,
      scheduled_for = now(),
      updated_at    = now()
  where id = p_job_id;

  -- Mark dead letter entry as resolved
  update dead_letter_jobs
  set resolved_at    = now(),
      resolved_by    = p_actor,
      resolution_notes = 'Manual retry'
  where job_id = p_job_id
    and resolved_at is null;

  return true;
end;
$$;

-- ── bulk_retry_dead_letters ──────────────────────────────────
create or replace function bulk_retry_dead_letters(
  p_filters jsonb default '{}'::jsonb
) returns jsonb language plpgsql as $$
declare
  v_integration text := p_filters->>'integration';
  v_site_id     bigint := (p_filters->>'site_id')::bigint;
  v_since       timestamptz := (p_filters->>'since')::timestamptz;
  v_max_count   int := coalesce((p_filters->>'max_count')::int, 100);
  v_job_ids     uuid[];
  v_job_id      uuid;
begin
  select array_agg(j.id) into v_job_ids
  from (
    select id from integration_jobs
    where status = 'dead_letter'
      and (v_integration is null or integration = v_integration)
      and (v_site_id is null or site_id = v_site_id)
      and (v_since is null or last_error_at >= v_since)
    order by last_error_at desc
    limit v_max_count
  ) j;

  if v_job_ids is null then
    return jsonb_build_object('count', 0, 'job_ids', '[]'::jsonb);
  end if;

  foreach v_job_id in array v_job_ids loop
    perform retry_dead_letter_job(v_job_id, 'bulk_retry');
  end loop;

  return jsonb_build_object(
    'count',   array_length(v_job_ids, 1),
    'job_ids', to_jsonb(v_job_ids)
  );
end;
$$;

-- ── claim_due_schedules ──────────────────────────────────────
create or replace function claim_due_schedules(p_limit int default 50)
returns table (schedule_id uuid, job_id uuid) language plpgsql as $$
declare
  v_schedule record;
  v_job_id   uuid;
  v_idem_key text;
begin
  for v_schedule in
    select * from sync_schedules
    where status = 'active'
      and next_run_at <= now()
    order by next_run_at asc
    limit p_limit
    for update skip locked
  loop
    -- Bucket by interval so sub-minute schedules get unique idempotency keys
    v_idem_key := 'sync:' || v_schedule.integration || ':' || v_schedule.site_id
                  || ':' || v_schedule.sync_type
                  || ':' || floor(extract(epoch from now()) / v_schedule.interval_seconds)::bigint;

    v_job_id := enqueue_job(
      v_schedule.site_id,
      'pos_sync',
      v_schedule.sync_type,
      v_schedule.integration,
      v_idem_key,
      jsonb_build_object(
        'schedule_id', v_schedule.id,
        'cursor', v_schedule.last_cursor,
        'config', v_schedule.config
      ),
      1,
      jsonb_build_array(
        jsonb_build_object(
          'step_name', v_schedule.sync_type,
          'max_attempts', 3,
          'input', jsonb_build_object(
            'schedule_id', v_schedule.id,
            'cursor', v_schedule.last_cursor
          )
        )
      )
    );

    -- Advance next_run_at
    update sync_schedules
    set next_run_at = now() + (interval_seconds || ' seconds')::interval,
        last_run_at = now(),
        updated_at  = now()
    where id = v_schedule.id;

    schedule_id := v_schedule.id;
    job_id      := v_job_id;
    return next;
  end loop;
end;
$$;

-- ── complete_sync_schedule ───────────────────────────────────
create or replace function complete_sync_schedule(
  p_schedule_id uuid,
  p_cursor      text default null
) returns void language plpgsql as $$
begin
  update sync_schedules
  set last_cursor          = coalesce(p_cursor, last_cursor),
      consecutive_failures = 0,
      last_error           = null,
      status               = 'active',
      updated_at           = now()
  where id = p_schedule_id;
end;
$$;

-- ── fail_sync_schedule ───────────────────────────────────────
create or replace function fail_sync_schedule(
  p_schedule_id uuid,
  p_error       text
) returns void language plpgsql as $$
declare
  v_failures int;
begin
  update sync_schedules
  set consecutive_failures = consecutive_failures + 1,
      last_error           = p_error,
      updated_at           = now()
  where id = p_schedule_id
  returning consecutive_failures into v_failures;

  -- Mark as failing after 5 consecutive failures
  if v_failures >= 5 then
    update sync_schedules
    set status = 'failing', updated_at = now()
    where id = p_schedule_id;
  end if;
end;
$$;

-- ── enqueue_alert ────────────────────────────────────────────
create or replace function enqueue_alert(
  p_dedupe_key  text,
  p_severity    alert_severity,
  p_event_type  text,
  p_subject     text,
  p_body        text,
  p_metadata    jsonb default '{}'::jsonb,
  p_site_id     bigint default null,
  p_integration text default null
) returns uuid language plpgsql as $$
declare
  v_existing_id uuid;
  v_new_id      uuid;
begin
  -- Look for a pending alert with same dedupe_key created in last 5 minutes
  select id into v_existing_id
  from alerts_outbox
  where dedupe_key = p_dedupe_key
    and status = 'pending'
    and created_at >= now() - interval '5 minutes'
  order by created_at desc
  limit 1;

  if v_existing_id is not null then
    update alerts_outbox
    set count        = count + 1,
        last_seen_at = now(),
        metadata     = metadata || p_metadata,
        updated_at   = now()
    where id = v_existing_id;
    return v_existing_id;
  end if;

  insert into alerts_outbox (
    dedupe_key, severity, event_type, subject, body,
    metadata, site_id, integration
  ) values (
    p_dedupe_key, p_severity, p_event_type, p_subject, p_body,
    p_metadata, p_site_id, p_integration
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ── claim_pending_alerts ─────────────────────────────────────
create or replace function claim_pending_alerts(
  p_worker_id text,
  p_limit     int default 20
) returns setof alerts_outbox language plpgsql as $$
begin
  return query
    select * from alerts_outbox
    where status = 'pending'
    order by created_at asc
    limit p_limit
    for update skip locked;
end;
$$;

-- ── mark_alert_sent ──────────────────────────────────────────
create or replace function mark_alert_sent(p_alert_id uuid)
returns void language plpgsql as $$
begin
  update alerts_outbox
  set status     = 'sent',
      sent_at    = now(),
      updated_at = now()
  where id = p_alert_id;
end;
$$;

-- ── mark_alert_failed ────────────────────────────────────────
create or replace function mark_alert_failed(p_alert_id uuid, p_reason text)
returns void language plpgsql as $$
begin
  update alerts_outbox
  set status        = 'failed',
      failed_reason = p_reason,
      updated_at    = now()
  where id = p_alert_id;
end;
$$;

-- ── mark_alert_suppressed ────────────────────────────────────
create or replace function mark_alert_suppressed(p_alert_id uuid, p_reason text)
returns void language plpgsql as $$
begin
  update alerts_outbox
  set status        = 'suppressed',
      failed_reason = p_reason,
      updated_at    = now()
  where id = p_alert_id;
end;
$$;

-- ── tg_handle_sync_dead_letter ───────────────────────────────
-- When a sync job becomes dead_letter, update its schedule status
create or replace function tg_handle_sync_dead_letter()
returns trigger language plpgsql as $$
begin
  if new.status = 'dead_letter' and new.queue_name = 'pos_sync' then
    perform fail_sync_schedule(
      (new.payload->>'schedule_id')::uuid,
      coalesce(new.last_error, 'Job reached dead_letter')
    );
  end if;
  return new;
end;
$$;

create trigger tg_jobs_sync_dead_letter
  after update of status on integration_jobs
  for each row
  when (new.status = 'dead_letter' and new.queue_name = 'pos_sync')
  execute function tg_handle_sync_dead_letter();

-- ── tg_emit_dead_letter_alert ────────────────────────────────
-- After a job enters dead_letter_jobs, enqueue an email alert
create or replace function tg_emit_dead_letter_alert()
returns trigger language plpgsql as $$
declare
  v_integration text;
  v_site_id     bigint;
begin
  select integration, site_id
  into v_integration, v_site_id
  from integration_jobs
  where id = new.job_id;

  perform enqueue_alert(
    'dead_letter:' || v_integration || ':' || coalesce(v_site_id::text, 'all'),
    'warning',
    'dead_letter',
    '[WARNING] Dead letter: ' || v_integration,
    'Job ' || new.job_id || ' reached dead_letter state.' || chr(10)
    || 'Reason: ' || new.reason || chr(10)
    || 'Site: ' || coalesce(v_site_id::text, 'unknown'),
    jsonb_build_object(
      'job_id',      new.job_id,
      'last_error',  new.reason,
      'integration', v_integration,
      'site_id',     v_site_id
    ),
    v_site_id,
    v_integration
  );

  return new;
end;
$$;

create trigger tg_dead_letter_alert
  after insert on dead_letter_jobs
  for each row execute function tg_emit_dead_letter_alert();
