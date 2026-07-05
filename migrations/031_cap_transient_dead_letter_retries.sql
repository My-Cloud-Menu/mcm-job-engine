-- 031: Cap de 2h al auto-retry de dead-letters transitorios (Omnivore/Clover) + escalación.
--
-- Antes (024): un dead-letter transitorio (POS caído/timeout/5xx) se re-absorbía cada 5 min
-- INDEFINIDAMENTE — `retry_dead_letter_job` resetea attempt_count=0 y `last_error_at` se refresca
-- en cada falla, así que nunca envejecía fuera de la ventana de 6h.
--
-- Ahora: se acota el auto-retry a `now() - created_at < 2h`. (`created_at` es estable: enqueue_job
-- es ON CONFLICT DO NOTHING y retry_dead_letter_job NO lo toca → mide el tiempo real atascado.)
-- Al cruzar las 2h: se DETIENE el auto-retry y se escala UNA alerta `critical` (dedup por-job +
-- marcador `context.retry_capped_alerted` para no re-alertar cada 5 min). El job queda en dead_letter
-- para revisión manual.
--
-- Firma IDÉNTICA a 024 → CREATE OR REPLACE limpio; el cron.schedule y los grants quedan intactos.
-- Patrón de 024 conservado: materializar candidatos en arrays y LUEGO actuar (no modificar filas
-- mientras se itera un cursor sobre esas mismas filas). La escalación va en un sub-bloque con
-- EXCEPTION → una alerta fallida nunca aborta los retries ni el cron.

create or replace function public.retry_transient_dead_letters(
  p_integration text        default null,   -- null ⇒ omnivore + clover
  p_since       timestamptz default null,   -- default: últimas 6h
  p_max         int         default 50
) returns jsonb language plpgsql as $$
declare
  v_since        timestamptz := coalesce(p_since, now() - interval '6 hours');
  v_cap          constant interval := interval '2 hours';  -- techo del auto-retry transitorio
  v_retry_ids    uuid[];
  v_escalate_ids uuid[];
  v_id           uuid;
  v_int          text;
  v_site         bigint;
  v_err          text;
  v_retried      int := 0;
  v_capped       int := 0;
begin
  -- UN solo scan de candidatos transitorios (mismo predicado que 024) → dos conjuntos:
  --   aged=false  → dentro de 2h  → reabsorber (comportamiento actual)
  --   aged=true   → pasó 2h        → escalar una vez y dejar en dead_letter
  with c as (
    select
      id,
      (created_at < now() - v_cap) as aged,
      coalesce((context->>'retry_capped_alerted')::boolean, false) as alerted
    from integration_jobs
    where status = 'dead_letter'
      and last_error_at >= v_since
      and (
        (p_integration is not null and integration = p_integration)
        or (p_integration is null and integration in ('omnivore', 'clover'))
      )
      -- Solo errores TRANSITORIOS (no de negocio). Bloque verbatim de la migr 024.
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
  )
  select
    array_agg(id) filter (where not aged),
    array_agg(id) filter (where aged and not alerted)
  into v_retry_ids, v_escalate_ids
  from c;

  -- (1) RETRIES — idéntico a 024 (dentro del techo de 2h). Comportamiento actual, sin cambios.
  if v_retry_ids is not null then
    foreach v_id in array v_retry_ids loop
      perform retry_dead_letter_job(v_id, 'auto_transient');
      v_retried := v_retried + 1;
    end loop;
  end if;

  -- (2) ESCALACIÓN — nuevo. Cada item en su propio sub-bloque: una alerta fallida NO aborta
  -- los retries ya hechos ni el resto del cron.
  if v_escalate_ids is not null then
    foreach v_id in array v_escalate_ids loop
      begin
        select integration, site_id, last_error
          into v_int, v_site, v_err
          from integration_jobs
         where id = v_id;

        perform enqueue_alert(
          'retry_capped:' || v_id,
          'critical'::alert_severity,
          'retry_capped',
          '[CRITICAL] Auto-retry detenido (>2h): ' || v_int,
          'El job ' || v_id || ' (' || v_int || ') lleva mas de 2h fallando por causa transitoria; '
            || 'se detuvo el auto-retry para no reintentar indefinidamente. '
            || 'Revisar: POS caido prolongado o ticket inexistente. '
            || 'Ultimo error: ' || coalesce(v_err, '(sin detalle)'),
          jsonb_build_object(
            'job_id', v_id, 'integration', v_int, 'site_id', v_site,
            'reason', 'transient_retry_capped_2h'
          ),
          v_site,
          v_int
        );

        update integration_jobs
           set context    = context || jsonb_build_object('retry_capped_alerted', true),
               updated_at = now()
         where id = v_id;

        v_capped := v_capped + 1;
      exception when others then
        raise warning 'retry_capped escalation failed for job %: %', v_id, sqlerrm;
      end;
    end loop;
  end if;

  return jsonb_build_object(
    'count',   v_retried,
    'capped',  v_capped,
    'job_ids', to_jsonb(coalesce(v_retry_ids, '{}'::uuid[]))
  );
end;
$$;
