-- ============================================================
-- 009_clover_fetch_payments_schedule.sql
-- Extiende ensure_sync_schedules: además de fetch_open_orders (60s) y
-- fetch_closed_orders (300s), clover ahora provisiona fetch_payments con
-- intervalo configurable por tenant (config.cloverPaymentSyncIntervalSeconds,
-- default 30s). Reemplaza el pull externo `clover-payment-notification`.
-- ============================================================

create or replace function ensure_sync_schedules(
  p_site_id    bigint,
  p_integration text,
  p_enabled     boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_affected int := 0;
  v_pay_interval int := 30;
begin
  if p_integration not in ('clover', 'omnivore') then
    return jsonb_build_object('affected', 0, 'action', 'noop');
  end if;

  if p_enabled then
    if p_integration = 'clover' then
      -- intervalo del pull de pagos desde la config de la integración (default 30s)
      select coalesce(
               nullif(si.config->>'cloverPaymentSyncIntervalSeconds','')::int,
               30)
        into v_pay_interval
      from site_integrations si
      where si.site_id = p_site_id and si.type = 'pos' and si.provider = 'clover' and si.active
      limit 1;
      if v_pay_interval is null or v_pay_interval < 5 then v_pay_interval := 30; end if;

      insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
      values
        (p_site_id, 'clover', 'fetch_open_orders',   60,             'active', now()),
        (p_site_id, 'clover', 'fetch_closed_orders', 300,            'active', now()),
        (p_site_id, 'clover', 'fetch_payments',      v_pay_interval, 'active', now())
      on conflict (site_id, integration, sync_type)
      do update set
        status     = 'active',
        updated_at = now()
      where sync_schedules.status <> 'active';
      get diagnostics v_affected = row_count;

    elsif p_integration = 'omnivore' then
      insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
      values
        (p_site_id, 'omnivore', 'fetch_recent_orders', 60, 'active', now())
      on conflict (site_id, integration, sync_type)
      do update set
        status     = 'active',
        updated_at = now()
      where sync_schedules.status <> 'active';
      get diagnostics v_affected = row_count;
    end if;

    return jsonb_build_object('affected', v_affected, 'action', 'enabled');

  else
    update sync_schedules
    set status     = 'disabled',
        updated_at = now()
    where site_id     = p_site_id
      and integration  = p_integration
      and status      <> 'disabled';
    get diagnostics v_affected = row_count;

    return jsonb_build_object('affected', v_affected, 'action', 'disabled');
  end if;
end;
$$;

grant execute on function ensure_sync_schedules(bigint, text, boolean) to authenticated;
