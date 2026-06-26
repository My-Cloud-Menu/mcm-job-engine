-- Fix (rush stability): auto-recover injection dead-letters caused by TRANSIENT POS failures.
--
-- Auditoría 2026-06-13: bajo rush, cuando el POS se cae (`pos_offline`/timeout), algunos jobs
-- agotan reintentos → dead_letter. No duplican, pero hoy NO se auto-recuperan desde el trigger
-- (la idempotency_key ya existe → ON CONFLICT). Cuando el POS se recupera tras el rush, esos
-- jobs deben reabsorberse sin intervención manual.
--
-- `bulk_retry_dead_letters` reintenta TODO (incluiría errores de NEGOCIO no-retryables, que solo
-- volverían a morir). Esta función reintenta SOLO fallos transitorios (POS offline / timeout /
-- 5xx / red) y SOLO de integraciones POS idempotentes (omnivore, clover) — NUNCA notificaciones
-- (twilio/sendgrid) para no re-enviar SMS/email. La inyección POS es idempotente (markers +
-- guards de resume), así que reintentar es seguro y convergente.

create or replace function public.retry_transient_dead_letters(
  p_integration text default null,                          -- null ⇒ omnivore + clover
  p_since       timestamptz default null,                   -- default: últimas 6h
  p_max         int default 50
) returns jsonb language plpgsql as $$
declare
  v_since timestamptz := coalesce(p_since, now() - interval '6 hours');
  v_ids   uuid[];
  v_id    uuid;
begin
  select array_agg(id) into v_ids from (
    select id
    from integration_jobs
    where status = 'dead_letter'
      and last_error_at >= v_since
      and (
        (p_integration is not null and integration = p_integration)
        or (p_integration is null and integration in ('omnivore', 'clover'))
      )
      -- Solo errores TRANSITORIOS (no de negocio: reference_not_found, invalid_payload,
      -- excessive_amount, ticket_closed, "No handler registered", "already has payments", etc.).
      and (
           last_error ilike '%pos_offline%'
        or last_error ilike '%pos is not running%'
        or last_error ilike '%pos_not_responding%'
        or last_error ilike '%agent_offline%'
        or last_error ilike '%agent is offline%'
        or last_error ilike '%timeout%'
        or last_error ilike '%cache_still_loading%'
        or last_error ilike '%internal_error%'
        or last_error ilike '%network error%'
        or last_error ilike '%ECONNABORTED%'
        or last_error ilike '%HTTP 50%'   -- 500/502/503/504
        or last_error ilike '%HTTP 429%'
      )
    order by last_error_at desc
    limit p_max
  ) j;

  if v_ids is null then
    return jsonb_build_object('count', 0, 'job_ids', '[]'::jsonb);
  end if;

  foreach v_id in array v_ids loop
    perform retry_dead_letter_job(v_id, 'auto_transient');
  end loop;

  return jsonb_build_object('count', array_length(v_ids, 1), 'job_ids', to_jsonb(v_ids));
end;
$$;

-- Lock down: service-role / postgres only (worker invoca por RPC; el cron corre como dueño).
revoke all on function public.retry_transient_dead_letters(text, timestamptz, int) from public;
grant execute on function public.retry_transient_dead_letters(text, timestamptz, int) to service_role;

-- Cron cada 5 min: reabsorbe inyecciones POS difuntas por causa transitoria una vez el POS vuelve.
select cron.schedule(
  'retry-transient-pos-dead-letters',
  '*/5 * * * *',
  $$ select public.retry_transient_dead_letters() $$
);
