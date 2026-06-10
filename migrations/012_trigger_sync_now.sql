-- ============================================================
-- 012_trigger_sync_now.sql
-- Disparo manual de sync ("Probar ahora" en el dashboard). Encola UNA sola
-- ejecución de pos_sync para (site, integration, sync_type) de inmediato,
-- independiente del estado del schedule recurrente. Reusa enqueue_job
-- (idempotente a nivel DB). Las credenciales las carga el worker desde
-- site_integrations, por eso la integración debe existir y estar guardada.
-- ============================================================

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
  -- Whitelist: sync_type válido para la integración.
  if not (
       (p_integration = 'clover'   and p_sync_type in ('fetch_open_orders', 'fetch_closed_orders', 'fetch_payments'))
    or (p_integration = 'omnivore' and p_sync_type in ('fetch_recent_orders'))
  ) then
    raise exception 'invalid sync_type % for integration %', p_sync_type, p_integration
      using errcode = '22023';
  end if;

  -- La integración debe existir y estar activa (el worker lee credenciales de aquí).
  if not exists (
    select 1 from site_integrations
     where site_id = p_site_id and provider = p_integration and type = 'pos' and active
  ) then
    raise exception 'no active % integration for site %', p_integration, p_site_id
      using errcode = 'P0002';
  end if;

  select * into v_schedule from sync_schedules
   where site_id = p_site_id and integration = p_integration and sync_type = p_sync_type
   limit 1;

  -- Único por click a resolución de segundo (clicks repetidos => nuevos jobs).
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

comment on function trigger_sync_now is
  'Encola una ejecución one-shot de pos_sync para el botón "Probar ahora" del dashboard. '
  'Valida sync_type por integración; requiere integración activa. El aislamiento de tenant '
  'es defensa upstream (RLS de site_integrations gatea quién llega al formulario).';
