-- ============================================================
-- 017_serialize_sync_enqueue.sql
-- Hardening de concurrencia (Fix 2 + Fix 4).
--
-- Fix 2 (serialización/eficiencia): no encolar un sync si ya hay un job ACTIVO
-- del mismo (site_id, integration, sync_type) en ('pending','running','retrying').
-- Evita que un sync lento que pase su intervalo dispare un 2º job concurrente
-- (que es lo que destapa la race de pagos). Se aplica en AMBOS productores:
-- claim_due_schedules (scheduler recurrente) y trigger_sync_now ("Probar ahora",
-- que bypassa el scheduler). El gate se auto-limpia: recover_stuck_jobs saca los
-- 'running' colgados a 'retrying' y un 'dead_letter' ya no cuenta como activo.
-- Nota: la garantía DE FONDO contra duplicados la dan los UNIQUE/RPC (016/018);
-- esto es serialización + eficiencia (menos llamadas API redundantes).
--
-- Fix 4 (defensa en profundidad): complete_sync_schedule avanza last_cursor solo
-- hacia adelante para cursores numéricos (evita regresión por un run viejo).
-- ============================================================

-- ── claim_due_schedules: gate de serialización ───────────────
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
    -- Gate: ¿ya hay un job activo de este mismo sync? Si sí, no encolar otro
    -- (devolvemos su id), pero igual avanzamos next_run_at → el próximo tick
    -- reintenta tras completar.
    select r.id into v_job_id
    from integration_jobs r
    where r.site_id = v_schedule.site_id
      and r.integration = v_schedule.integration
      and r.job_type = v_schedule.sync_type
      and r.status in ('pending', 'running', 'retrying')
    limit 1;

    if v_job_id is null then
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
    end if;

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

-- ── trigger_sync_now ("Probar ahora"): mismo gate ───────────
-- (bypassa el scheduler; reproduce 013 + el gate). Si ya hay un job activo del
-- mismo sync, retorna su id en vez de encolar otro.
create or replace function trigger_sync_now(
  p_site_id     bigint,
  p_integration text,
  p_sync_type   text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_schedule sync_schedules;
  v_job_id   uuid;
  v_idem     text;
begin
  if not (
       (p_integration = 'clover'   and p_sync_type in ('fetch_open_orders', 'fetch_closed_orders', 'fetch_payments', 'push_orders'))
    or (p_integration = 'omnivore' and p_sync_type in ('fetch_recent_orders'))
  ) then
    raise exception 'invalid sync_type % for integration %', p_sync_type, p_integration
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from site_integrations
     where site_id = p_site_id and provider = p_integration and type = 'pos' and active
  ) then
    raise exception 'no active % integration for site %', p_integration, p_site_id
      using errcode = 'P0002';
  end if;

  -- Gate: si ya hay un job activo de este sync, devolverlo (no duplicar el run).
  select id into v_job_id from integration_jobs
   where site_id = p_site_id and integration = p_integration and job_type = p_sync_type
     and status in ('pending', 'running', 'retrying')
   limit 1;
  if v_job_id is not null then
    return v_job_id;
  end if;

  select * into v_schedule from sync_schedules
   where site_id = p_site_id and integration = p_integration and sync_type = p_sync_type
   limit 1;

  v_idem := 'manual:' || p_integration || ':' || p_site_id || ':' || p_sync_type
            || ':' || floor(extract(epoch from clock_timestamp()))::bigint;

  v_job_id := enqueue_job(
    p_site_id,
    'pos_sync',
    p_sync_type,
    p_integration,
    v_idem,
    jsonb_build_object(
      'schedule_id', v_schedule.id,
      'cursor',      v_schedule.last_cursor,
      'config',      coalesce(v_schedule.config, '{}'::jsonb),
      'manual',      true
    ),
    1,
    jsonb_build_array(jsonb_build_object(
      'step_name',    p_sync_type,
      'max_attempts', 3,
      'input', jsonb_build_object(
        'schedule_id', v_schedule.id,
        'cursor',      v_schedule.last_cursor,
        'manual',      true
      )
    ))
  );

  return v_job_id;
end;
$$;

grant execute on function trigger_sync_now(bigint, text, text) to authenticated;

-- ── complete_sync_schedule: cursor monótono (Fix 4) ──────────
create or replace function complete_sync_schedule(
  p_schedule_id uuid,
  p_cursor      text default null
) returns void language plpgsql as $$
begin
  update sync_schedules
  set last_cursor = case
        when p_cursor is null then last_cursor
        when last_cursor is null then p_cursor
        -- cursores numéricos (ej. fetch_payments = modifiedTime ms): solo avanzar.
        when p_cursor ~ '^[0-9]+$' and last_cursor ~ '^[0-9]+$'
          then greatest(p_cursor::numeric, last_cursor::numeric)::text
        else p_cursor
      end,
      consecutive_failures = 0,
      last_error           = null,
      status               = 'active',
      updated_at           = now()
  where id = p_schedule_id;
end;
$$;
