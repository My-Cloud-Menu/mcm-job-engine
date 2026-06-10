-- ============================================================
-- 001_jobs_schema.sql
-- Core schema: ENUMs, tables, indexes, RLS, triggers
-- ============================================================

-- ── ENUMs ────────────────────────────────────────────────────
create type job_status as enum (
  'pending', 'running', 'retrying', 'completed', 'cancelled', 'dead_letter'
);

create type step_status as enum (
  'pending', 'running', 'completed', 'failed', 'skipped'
);

create type schedule_status as enum (
  'active', 'paused', 'failing', 'disabled'
);

create type alert_severity as enum (
  'info', 'warning', 'critical'
);

create type alert_status as enum (
  'pending', 'sent', 'suppressed', 'failed'
);

-- ── integration_jobs ────────────────────────────────────────
create table integration_jobs (
  id               uuid primary key default gen_random_uuid(),
  site_id          bigint not null references sites(id) on delete cascade,
  correlation_id   uuid not null default gen_random_uuid(),
  queue_name       text not null
                     check (queue_name in ('pos_injection','pos_sync','notifications','webhooks')),
  job_type         text not null,
  integration      text not null,
  idempotency_key  text not null unique,
  status           job_status not null default 'pending',
  current_step     int not null default 0,
  current_step_name text,
  total_steps      int not null,
  payload          jsonb not null,
  context          jsonb not null default '{}'::jsonb,
  last_error       text,
  last_error_at    timestamptz,
  reference_type   text,
  reference_id     text,
  priority         int not null default 5 check (priority between 1 and 10),
  scheduled_for    timestamptz not null default now(),
  locked_by        text,
  locked_until     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);

create index ix_jobs_queue_pick
  on integration_jobs (queue_name, priority desc, scheduled_for)
  where status in ('pending', 'retrying');

create index ix_jobs_site_created
  on integration_jobs (site_id, created_at desc);

create index ix_jobs_reference
  on integration_jobs (reference_type, reference_id);

create index ix_jobs_status_integration
  on integration_jobs (status, integration);

create index ix_jobs_locked
  on integration_jobs (locked_until)
  where locked_by is not null;

create index ix_jobs_dead_letter
  on integration_jobs (last_error_at desc)
  where status = 'dead_letter';

create index ix_jobs_correlation
  on integration_jobs (correlation_id);

-- ── job_steps ────────────────────────────────────────────────
create table job_steps (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references integration_jobs(id) on delete cascade,
  step_index       int not null,
  step_name        text not null,
  status           step_status not null default 'pending',
  idempotency_key  text unique,  -- null allowed; unique when present
  max_attempts     int not null default 3,
  attempt_count    int not null default 0,
  input            jsonb,
  output           jsonb,
  last_error       text,
  next_retry_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  constraint uq_job_step unique (job_id, step_index)
);

create index ix_steps_job_id on job_steps (job_id);

-- ── job_step_attempts ────────────────────────────────────────
create table job_step_attempts (
  id               uuid primary key default gen_random_uuid(),
  step_id          uuid not null references job_steps(id) on delete cascade,
  job_id           uuid not null references integration_jobs(id) on delete cascade,
  site_id          bigint not null,
  attempt_number   int not null,
  request_payload  jsonb,
  response_status  int,
  response_body    jsonb,
  success          boolean not null,
  error_message    text,
  error_code       text,
  is_retryable     boolean,
  duration_ms      int,
  worker_id        text,
  created_at       timestamptz not null default now()
);

create index ix_attempts_step_id  on job_step_attempts (step_id);
create index ix_attempts_job_id   on job_step_attempts (job_id);
create index ix_attempts_site_id  on job_step_attempts (site_id, created_at desc);

-- ── dead_letter_jobs ────────────────────────────────────────
create table dead_letter_jobs (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references integration_jobs(id) on delete cascade,
  site_id          bigint not null,
  reason           text not null,
  failed_at        timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      text,
  resolution_notes text,
  created_at       timestamptz not null default now()
);

create index ix_dl_job_id  on dead_letter_jobs (job_id);
create index ix_dl_site_id on dead_letter_jobs (site_id, failed_at desc);

-- ── integration_concurrency_limits ──────────────────────────
create table integration_concurrency_limits (
  id              uuid primary key default gen_random_uuid(),
  queue_name      text,
  integration     text,
  site_id         bigint references sites(id) on delete cascade,
  max_concurrency int not null default 10,
  enabled         boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- At least one discriminator must be defined
  constraint ck_at_least_one check (
    queue_name is not null or integration is not null or site_id is not null
  ),
  -- Unique combination including nulls (NULLS NOT DISTINCT requires PG 15+)
  constraint uq_concurrency_limit unique nulls not distinct (queue_name, integration, site_id)
);

-- ── sync_schedules ──────────────────────────────────────────
create table sync_schedules (
  id                 uuid primary key default gen_random_uuid(),
  site_id            bigint not null references sites(id) on delete cascade,
  integration        text not null,
  sync_type          text not null,
  status             schedule_status not null default 'active',
  interval_seconds   int not null default 30,
  last_run_at        timestamptz,
  next_run_at        timestamptz not null default now(),
  last_cursor        text,
  last_error         text,
  consecutive_failures int not null default 0,
  config             jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uq_sync_schedule unique (site_id, integration, sync_type)
);

create index ix_schedules_due
  on sync_schedules (next_run_at)
  where status = 'active';

create index ix_schedules_site_id on sync_schedules (site_id);

-- ── alerts_outbox ────────────────────────────────────────────
create table alerts_outbox (
  id              uuid primary key default gen_random_uuid(),
  dedupe_key      text not null,
  severity        alert_severity not null,
  event_type      text not null,
  subject         text not null,
  body            text not null,
  metadata        jsonb not null default '{}'::jsonb,
  site_id         bigint references sites(id) on delete set null,
  integration     text,
  status          alert_status not null default 'pending',
  sent_at         timestamptz,
  failed_reason   text,
  count           int not null default 1,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index ix_alerts_pending
  on alerts_outbox (status, created_at)
  where status = 'pending';

create index ix_alerts_dedupe
  on alerts_outbox (dedupe_key, last_seen_at desc);

create index ix_alerts_severity
  on alerts_outbox (severity, created_at desc);

-- ── alert_send_log ───────────────────────────────────────────
create table alert_send_log (
  id          uuid primary key default gen_random_uuid(),
  recipient   text not null,
  sent_at     timestamptz not null default now()
);

create index ix_alert_log_recipient
  on alert_send_log (recipient, sent_at desc);

-- ── RLS ─────────────────────────────────────────────────────
-- All tables use RLS; only service_role can access by default.
-- Extend these policies when building user-facing APIs.

alter table integration_jobs          enable row level security;
alter table job_steps                 enable row level security;
alter table job_step_attempts         enable row level security;
alter table dead_letter_jobs          enable row level security;
alter table integration_concurrency_limits enable row level security;
alter table sync_schedules            enable row level security;
alter table alerts_outbox             enable row level security;
alter table alert_send_log            enable row level security;

create policy "service_role_only" on integration_jobs
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "service_role_only" on job_steps
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "service_role_only" on job_step_attempts
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "service_role_only" on dead_letter_jobs
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "service_role_only" on integration_concurrency_limits
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "service_role_only" on sync_schedules
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "service_role_only" on alerts_outbox
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "service_role_only" on alert_send_log
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ── updated_at trigger ───────────────────────────────────────
create or replace function tg_update_timestamp()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tg_jobs_updated_at
  before update on integration_jobs
  for each row execute function tg_update_timestamp();

create trigger tg_steps_updated_at
  before update on job_steps
  for each row execute function tg_update_timestamp();

create trigger tg_limits_updated_at
  before update on integration_concurrency_limits
  for each row execute function tg_update_timestamp();

create trigger tg_schedules_updated_at
  before update on sync_schedules
  for each row execute function tg_update_timestamp();

create trigger tg_alerts_updated_at
  before update on alerts_outbox
  for each row execute function tg_update_timestamp();

-- ── NOTIFY triggers ──────────────────────────────────────────
create or replace function tg_notify_new_job()
returns trigger language plpgsql as $$
begin
  if new.status in ('pending', 'retrying') then
    perform pg_notify('jobs_' || new.queue_name, new.id::text);
  end if;
  return new;
end;
$$;

create trigger tg_jobs_notify
  after insert or update of status on integration_jobs
  for each row execute function tg_notify_new_job();

create or replace function tg_notify_new_alert()
returns trigger language plpgsql as $$
begin
  perform pg_notify('alerts_channel', new.id::text);
  return new;
end;
$$;

create trigger tg_alerts_notify
  after insert on alerts_outbox
  for each row execute function tg_notify_new_alert();
