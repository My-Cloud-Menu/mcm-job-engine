-- ============================================================
-- 032_sync_never_dead_ends.sql
--
-- El sync SIEMPRE corre. Si una integración se cae 3 horas y vuelve, el sync la retoma solo.
--
-- Problema encontrado el 2026-08-06 (incidente Arena Medalla, site 51021421):
-- `fail_sync_schedule` pone `status = 'failing'` a los 5 fallos consecutivos, y
-- `claim_due_schedules` sólo mira `status = 'active'` → el schedule deja de encolarse PARA
-- SIEMPRE. `complete_sync_schedule` lo devolvería a 'active' al primer éxito, pero ese éxito
-- nunca puede ocurrir porque ya nadie lo ejecuta. Punto muerto que sólo se sale a mano.
--
-- No es teórico: al detectarlo había 8 schedules de Clover (sites 25512412, 70017001, 99990001)
-- muertos desde el 19-20 de julio — 17 días sin sincronizar y sin que nadie los reactivara.
--
-- Cambio: `claim_due_schedules` toma también los 'failing', pero con la cadencia atenuada a un
-- mínimo de 5 minutos mientras arrastren >= 5 fallos seguidos. Así nunca se rinde y tampoco
-- martillea un POS caído. Al primer éxito, `complete_sync_schedule` pone `consecutive_failures`
-- en 0 y el status en 'active' → la cadencia normal vuelve sola.
--
-- 'failing' pasa a ser una SEÑAL de salud (la vista `sync_status` la sigue mostrando), no un
-- interruptor. 'paused' y 'disabled' siguen fuera: esos son apagados intencionales.
--
-- Firma idéntica → CREATE OR REPLACE limpio, sin tocar grants. El resto del cuerpo (gate de
-- serialización de la migración 017, idempotency key por ventana de tiempo, enqueue_job) queda
-- verbatim.
-- ============================================================

create or replace function claim_due_schedules(p_limit int default 50)
returns table (schedule_id uuid, job_id uuid) language plpgsql as $$
declare
  v_schedule record;
  v_job_id   uuid;
  v_idem_key text;
  v_next     interval;
begin
  for v_schedule in
    select * from sync_schedules
    where status in ('active', 'failing')   -- 032: 'failing' ya no es punto muerto
      and next_run_at <= now()
    order by next_run_at asc
    limit p_limit
    for update skip locked
  loop
    -- Gate de serialización (017): ¿ya hay un job activo de este mismo sync? Si sí, no encolar
    -- otro (devolvemos su id), pero igual avanzamos next_run_at → el próximo tick reintenta.
    select r.id into v_job_id
    from integration_jobs r
    where r.site_id = v_schedule.site_id
      and r.integration = v_schedule.integration
      and r.job_type = v_schedule.sync_type
      and r.status in ('pending', 'running', 'retrying')
    limit 1;

    if v_job_id is null then
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

    -- 032: cadencia atenuada mientras el schedule viene fallando. Sigue vivo (reintenta cada
    -- 5 min como mínimo) pero no martillea un POS caído a 20s. Al primer éxito,
    -- complete_sync_schedule resetea consecutive_failures y vuelve la cadencia normal.
    v_next := greatest(
      (v_schedule.interval_seconds || ' seconds')::interval,
      case when v_schedule.consecutive_failures >= 5 then interval '5 minutes'
           else interval '0 seconds' end
    );

    update sync_schedules
    set next_run_at = now() + v_next,
        last_run_at = now(),
        updated_at  = now()
    where id = v_schedule.id;

    schedule_id := v_schedule.id;
    job_id      := v_job_id;
    return next;
  end loop;
end;
$$;
