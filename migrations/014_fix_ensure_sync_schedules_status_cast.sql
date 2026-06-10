-- ============================================================
-- 014_fix_ensure_sync_schedules_status_cast.sql
--
-- BUGFIX: ensure_sync_schedules (introducido en 011, arrastrado a 013) nunca
-- pudo crear filas de sync_schedules.
--
-- `sync_schedules.status` es del enum `schedule_status`. Las expresiones
-- `case when ... then 'active' else 'disabled' end` tienen tipo `text`, y
-- Postgres NO castea `text -> enum` de forma implícita en un INSERT (sólo lo
-- hace con un literal "unknown" suelto como `'active'`, no con el resultado de
-- un CASE). Resultado: el INSERT fallaba con
--   "column status is of type schedule_status but expression is of type text"
-- y la función abortaba sin provisionar ningún schedule.
--
-- Síntoma observado: al guardar la integración de Clover desde el dashboard
-- (que llama a este RPC), los schedules `fetch_payments` / `push_orders` /
-- `fetch_open_orders` / `fetch_closed_orders` nunca se creaban → el sync
-- automático no ocurría (sólo el botón "Probar ahora", que va por
-- trigger_sync_now → enqueue_job directo, funcionaba). Como efecto colateral,
-- "Probar ahora" de Pagos caía en dead_letter ("schedule_id: Expected string,
-- received null") porque trigger_sync_now no encontraba fila de schedule.
--
-- FIX: castear cada expresión CASE a ::schedule_status en ambos INSERT
-- (ramas clover y omnivore). Sin otros cambios funcionales.
-- ============================================================

create or replace function ensure_sync_schedules(
  p_site_id     bigint,
  p_integration text,
  p_enabled     boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_affected      int := 0;
  v_pay_interval  int := 30;
  v_push_interval int := 30;
  v_orders_on     boolean := false;
  v_payments_on   boolean := false;
  v_push_on       boolean := false;
  v_config        jsonb;
begin
  if p_integration not in ('clover', 'omnivore') then
    return jsonb_build_object('affected', 0, 'action', 'noop');
  end if;

  -- Master off (integración inactiva) -> deshabilita todo para (site, integration).
  if not coalesce(p_enabled, false) then
    update sync_schedules
       set status = 'disabled', updated_at = now()
     where site_id = p_site_id and integration = p_integration and status <> 'disabled';
    get diagnostics v_affected = row_count;
    return jsonb_build_object('affected', v_affected, 'action', 'disabled');
  end if;

  select si.config into v_config
    from site_integrations si
   where si.site_id = p_site_id and si.type = 'pos' and si.provider = p_integration and si.active
   limit 1;

  if p_integration = 'clover' then
    v_orders_on    := coalesce((v_config->>'sync_orders')::boolean, false);
    v_payments_on  := coalesce((v_config->>'sync_payments')::boolean, false);
    v_push_on      := coalesce((v_config->>'sync_orders_to_clover')::boolean, false);

    v_pay_interval := coalesce(nullif(v_config->>'cloverPaymentSyncIntervalSeconds', '')::int, 30);
    if v_pay_interval is null or v_pay_interval < 5 then v_pay_interval := 30; end if;

    v_push_interval := coalesce(nullif(v_config->>'cloverPushSyncIntervalSeconds', '')::int, 30);
    if v_push_interval is null or v_push_interval < 5 then v_push_interval := 30; end if;

    insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
    values
      (p_site_id, 'clover', 'fetch_open_orders',   60,              (case when v_orders_on   then 'active' else 'disabled' end)::schedule_status, now()),
      (p_site_id, 'clover', 'fetch_closed_orders', 300,             (case when v_orders_on   then 'active' else 'disabled' end)::schedule_status, now()),
      (p_site_id, 'clover', 'fetch_payments',      v_pay_interval,  (case when v_payments_on then 'active' else 'disabled' end)::schedule_status, now()),
      (p_site_id, 'clover', 'push_orders',         v_push_interval, (case when v_push_on     then 'active' else 'disabled' end)::schedule_status, now())
    on conflict (site_id, integration, sync_type)
    do update set
      status = excluded.status,
      -- intervalos editables por tenant (pagos + push); los demás conservan el suyo
      interval_seconds = case when sync_schedules.sync_type in ('fetch_payments', 'push_orders')
                              then excluded.interval_seconds else sync_schedules.interval_seconds end,
      next_run_at = case when sync_schedules.status <> 'active' and excluded.status = 'active'
                         then now() else sync_schedules.next_run_at end,
      updated_at = now();
    get diagnostics v_affected = row_count;

  elsif p_integration = 'omnivore' then
    v_orders_on := coalesce((v_config->>'syncOrdersAutomatically')::boolean, false);

    insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
    values
      (p_site_id, 'omnivore', 'fetch_recent_orders', 60, (case when v_orders_on then 'active' else 'disabled' end)::schedule_status, now())
    on conflict (site_id, integration, sync_type)
    do update set
      status = excluded.status,
      next_run_at = case when sync_schedules.status <> 'active' and excluded.status = 'active'
                         then now() else sync_schedules.next_run_at end,
      updated_at = now();
    get diagnostics v_affected = row_count;
  end if;

  return jsonb_build_object(
    'affected', v_affected, 'action', 'synced',
    'orders', v_orders_on, 'payments', v_payments_on, 'push', v_push_on
  );
end;
$$;

grant execute on function ensure_sync_schedules(bigint, text, boolean) to authenticated;
