-- ============================================================
-- 033_sync_health_last_success.sql
--
-- La salud del sync deja de responder "¿pasó el scheduler por aquí?" y pasa a responder
-- "¿el sync trajo datos?".
--
-- Incidente del 2026-08-05 (Arena Medalla, site 51021421): 3h11m sin un solo sync de órdenes en
-- pleno servicio, y `sync_status.health` marcando 'healthy' TODO el rato. Dos razones:
--
--   1) `claim_due_schedules` avanza `last_run_at` y `next_run_at` aunque el gate de serialización
--      (017) decida NO encolar nada → el schedule nunca se ve "stale".
--   2) `consecutive_failures` sólo sube desde `fail_sync_schedule`, que dispara el trigger de
--      dead_letter... y con el circuit breaker abierto el handler nunca llegaba a correr, así que
--      el contador se quedaba en 0.
--
-- Cambios:
--   · `sync_schedules.last_success_at` — cuándo trajo datos por última vez. Lo escribe
--     `complete_sync_schedule`, que es el único punto que ya marca éxito y al que llaman los 16
--     sync_types vivos (8 handlers Omnivore, 6 Clover + push_orders, y auto_settle_dispatch).
--   · `claim_due_schedules` deja de avanzar `last_run_at` cuando salta el encolado. `next_run_at`
--     SÍ se sigue avanzando: gobierna el ritmo y evita que el scheduler re-evalúe la fila cada 5s.
--     `last_run_at` pasa a significar "último encolado real".
--   · La vista `sync_status` calcula 'stale' contra `last_success_at`, con un piso de 5 minutos
--     para que un hueco normal de 25s no dispare falsos positivos y un apagón de 3h sí.
--
-- Parte de la versión 032 de `claim_due_schedules` (status in ('active','failing') + cadencia
-- atenuada) — no revertir eso. Firma idéntica en ambas funciones → CREATE OR REPLACE limpio.
-- La vista añade `last_success_at` AL FINAL: CREATE OR REPLACE VIEW sólo admite columnas nuevas
-- al final, si se mete en medio hay que dropear (y `sync_status` tiene consumidores).
-- ============================================================

-- ── 1. Columna + backfill ────────────────────────────────────
alter table sync_schedules add column if not exists last_success_at timestamptz;

-- Sin backfill, TODO aparecería 'stale' el primer día. `last_run_at` es la mejor aproximación
-- disponible al último éxito para las filas que ya existen.
update sync_schedules
set last_success_at = last_run_at
where last_success_at is null
  and last_run_at is not null;

-- ── 2. complete_sync_schedule: marca el éxito ────────────────
create or replace function public.complete_sync_schedule(p_schedule_id uuid, p_cursor text default null)
returns void language plpgsql as $$
begin
  update sync_schedules
  set last_cursor = case
        when p_cursor is null then last_cursor
        when last_cursor is null then p_cursor
        when p_cursor ~ '^[0-9]+$' and last_cursor ~ '^[0-9]+$'
          then greatest(p_cursor::numeric, last_cursor::numeric)::text
        else p_cursor
      end,
      last_success_at      = now(),   -- 033
      consecutive_failures = 0,
      last_error           = null,
      status               = case when status = 'disabled' then status else 'active'::schedule_status end,
      updated_at           = now()
  where id = p_schedule_id;
end;
$$;

-- ── 3. claim_due_schedules: last_run_at sólo si encoló ───────
create or replace function public.claim_due_schedules(p_limit int default 50)
returns table (schedule_id uuid, job_id uuid) language plpgsql as $$
declare
  v_schedule record;
  v_job_id   uuid;
  v_idem_key text;
  v_next     interval;
  v_enqueued boolean;
begin
  for v_schedule in
    select * from sync_schedules
    where status in ('active', 'failing')   -- 032: 'failing' ya no es punto muerto
      and next_run_at <= now()
    order by next_run_at asc
    limit p_limit
    for update skip locked
  loop
    -- Gate de serialización (017): si ya hay un job activo de este sync, no encolar otro.
    select r.id into v_job_id
    from integration_jobs r
    where r.site_id = v_schedule.site_id
      and r.integration = v_schedule.integration
      and r.job_type = v_schedule.sync_type
      and r.status in ('pending', 'running', 'retrying')
    limit 1;

    v_enqueued := v_job_id is null;

    if v_enqueued then
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

    -- 032: cadencia atenuada mientras arrastre fallos; nunca se rinde, tampoco martillea.
    v_next := greatest(
      (v_schedule.interval_seconds || ' seconds')::interval,
      case when v_schedule.consecutive_failures >= 5 then interval '5 minutes'
           else interval '0 seconds' end
    );

    update sync_schedules
    set next_run_at = now() + v_next,
        -- 033: si el gate saltó el encolado, NO tocar last_run_at. Avanzarlo era la mentira que
        -- hacía imposible ver un sync congelado desde el tablero.
        last_run_at = case when v_enqueued then now() else last_run_at end,
        updated_at  = now()
    where id = v_schedule.id;

    schedule_id := v_schedule.id;
    job_id      := v_job_id;
    return next;
  end loop;
end;
$$;

-- ── 4. Vista sync_status: 'stale' contra el ÉXITO real ───────
create or replace view public.sync_status as
select
  id,
  site_id,
  integration,
  sync_type,
  status,
  interval_seconds,
  last_run_at,
  next_run_at,
  last_cursor,
  last_error,
  consecutive_failures,
  case
    when status = 'disabled'::schedule_status then 'disabled'::text
    when status = 'failing'::schedule_status  then 'failing'::text
    when status = 'paused'::schedule_status   then 'paused'::text
    -- 033: antes miraba next_run_at, que el scheduler refrescaba siempre → nunca daba 'stale'.
    -- El piso de 5 min evita falsos positivos en los syncs de 20s.
    when coalesce(last_success_at, created_at) < now() - greatest(
           ((interval_seconds * 3) || ' seconds')::interval,
           interval '5 minutes'
         ) then 'stale'::text
    when consecutive_failures > 0 then 'degraded'::text
    else 'healthy'::text
  end as health,
  last_success_at   -- 033: al final, para no romper CREATE OR REPLACE VIEW
from sync_schedules s
order by (
  case
    when status = 'disabled'::schedule_status then 'disabled'::text
    when status = 'failing'::schedule_status  then 'failing'::text
    when status = 'paused'::schedule_status   then 'paused'::text
    when coalesce(last_success_at, created_at) < now() - greatest(
           ((interval_seconds * 3) || ' seconds')::interval,
           interval '5 minutes'
         ) then 'stale'::text
    when consecutive_failures > 0 then 'degraded'::text
    else 'healthy'::text
  end
) desc, consecutive_failures desc;
