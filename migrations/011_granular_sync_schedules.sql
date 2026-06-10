-- ============================================================
-- 011_granular_sync_schedules.sql
-- Hace ensure_sync_schedules granular por sync_type, para que el dashboard
-- pueda prender/apagar cada cosa de forma independiente:
--   clover:   config.sync_orders   -> fetch_open_orders (60s) + fetch_closed_orders (300s)
--             config.sync_payments -> fetch_payments (interval = cloverPaymentSyncIntervalSeconds, default 30s)
--   omnivore: config.syncOrdersAutomatically -> fetch_recent_orders (60s)
-- p_enabled actúa como master switch (= integration.active): false -> deshabilita todo.
-- Reemplaza la versión de 009 (que acoplaba pagos al mismo flag de órdenes).
-- ============================================================

create or replace function ensure_sync_schedules(
  p_site_id     bigint,
  p_integration text,
  p_enabled     boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_affected     int := 0;
  v_pay_interval int := 30;
  v_orders_on    boolean := false;
  v_payments_on  boolean := false;
  v_config       jsonb;
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

  -- Lee la config de la integración activa (fuente de los flags por sync_type).
  select si.config into v_config
    from site_integrations si
   where si.site_id = p_site_id and si.type = 'pos' and si.provider = p_integration and si.active
   limit 1;

  if p_integration = 'clover' then
    v_orders_on    := coalesce((v_config->>'sync_orders')::boolean, false);
    v_payments_on  := coalesce((v_config->>'sync_payments')::boolean, false);
    v_pay_interval := coalesce(nullif(v_config->>'cloverPaymentSyncIntervalSeconds', '')::int, 30);
    if v_pay_interval is null or v_pay_interval < 5 then v_pay_interval := 30; end if;

    insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
    values
      (p_site_id, 'clover', 'fetch_open_orders',   60,             case when v_orders_on   then 'active' else 'disabled' end, now()),
      (p_site_id, 'clover', 'fetch_closed_orders', 300,            case when v_orders_on   then 'active' else 'disabled' end, now()),
      (p_site_id, 'clover', 'fetch_payments',      v_pay_interval, case when v_payments_on then 'active' else 'disabled' end, now())
    on conflict (site_id, integration, sync_type)
    do update set
      status = excluded.status,
      -- el intervalo de pagos es editable por tenant; los demás conservan el suyo
      interval_seconds = case when sync_schedules.sync_type = 'fetch_payments'
                              then excluded.interval_seconds else sync_schedules.interval_seconds end,
      -- al reactivar (disabled -> active) dispara pronto; si ya estaba active no lo empuja
      next_run_at = case when sync_schedules.status <> 'active' and excluded.status = 'active'
                         then now() else sync_schedules.next_run_at end,
      updated_at = now();
    get diagnostics v_affected = row_count;

  elsif p_integration = 'omnivore' then
    v_orders_on := coalesce((v_config->>'syncOrdersAutomatically')::boolean, false);

    insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
    values
      (p_site_id, 'omnivore', 'fetch_recent_orders', 60, case when v_orders_on then 'active' else 'disabled' end, now())
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
    'orders', v_orders_on, 'payments', v_payments_on
  );
end;
$$;

grant execute on function ensure_sync_schedules(bigint, text, boolean) to authenticated;

comment on function ensure_sync_schedules is
  'Provisiona sync_schedules de forma granular por sync_type a partir de los flags '
  'de la config de la integración (clover: sync_orders + sync_payments; omnivore: '
  'syncOrdersAutomatically). p_enabled = master (integration.active). Idempotente; '
  'conserva last_cursor. Reemplaza 009.';
