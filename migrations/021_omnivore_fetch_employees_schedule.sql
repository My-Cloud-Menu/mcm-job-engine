-- Wire the Omnivore employee sync into the scheduler + manual trigger.
-- ensure_sync_schedules: always provision an omnivore 'fetch_employees' row (24h),
-- active iff config.syncEmployeesAutomatically. trigger_sync_now: whitelist it.
-- + backfill a disabled row for existing active omnivore sites.

CREATE OR REPLACE FUNCTION public.ensure_sync_schedules(p_site_id bigint, p_integration text, p_enabled boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_affected int := 0; v_pay_interval int := 30; v_push_interval int := 30;
  v_orders_on boolean := false; v_payments_on boolean := false; v_push_on boolean := false;
  v_tables_on boolean := false; v_products_on boolean := false; v_employees_on boolean := false;
  v_config jsonb;
begin
  if p_integration not in ('clover', 'omnivore') then
    return jsonb_build_object('affected', 0, 'action', 'noop');
  end if;

  if not coalesce(p_enabled, false) then
    update sync_schedules set status = 'disabled', updated_at = now()
     where site_id = p_site_id and integration = p_integration and status <> 'disabled';
    get diagnostics v_affected = row_count;
    return jsonb_build_object('affected', v_affected, 'action', 'disabled');
  end if;

  select si.config into v_config from site_integrations si
   where si.site_id = p_site_id and si.type = 'pos' and si.provider = p_integration and si.active limit 1;

  if p_integration = 'clover' then
    v_orders_on   := coalesce((v_config->>'sync_orders')::boolean, false);
    v_payments_on := coalesce((v_config->>'sync_payments')::boolean, false);
    v_push_on     := coalesce((v_config->>'sync_orders_to_clover')::boolean, false);
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
    on conflict (site_id, integration, sync_type) do update set
      status = excluded.status,
      interval_seconds = case when sync_schedules.sync_type in ('fetch_payments', 'push_orders')
                              then excluded.interval_seconds else sync_schedules.interval_seconds end,
      next_run_at = case when sync_schedules.status <> 'active' and excluded.status = 'active' then now() else sync_schedules.next_run_at end,
      updated_at = now();
    get diagnostics v_affected = row_count;

  elsif p_integration = 'omnivore' then
    v_orders_on    := coalesce((v_config->>'syncOrdersAutomatically')::boolean, false);
    v_tables_on    := coalesce((v_config->>'syncTablesAutomatically')::boolean, false);
    v_products_on  := coalesce((v_config->>'syncProductsAutomatically')::boolean, false);
    v_employees_on := coalesce((v_config->>'syncEmployeesAutomatically')::boolean, false);

    insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
    values
      (p_site_id, 'omnivore', 'fetch_recent_orders', 60,    (case when v_orders_on    then 'active' else 'disabled' end)::schedule_status, now()),
      (p_site_id, 'omnivore', 'fetch_tables',        86400, (case when v_tables_on    then 'active' else 'disabled' end)::schedule_status, now()),
      (p_site_id, 'omnivore', 'fetch_products',      86400, (case when v_products_on  then 'active' else 'disabled' end)::schedule_status, now()),
      (p_site_id, 'omnivore', 'fetch_employees',     86400, (case when v_employees_on then 'active' else 'disabled' end)::schedule_status, now())
    on conflict (site_id, integration, sync_type) do update set
      status = excluded.status,
      next_run_at = case when sync_schedules.status <> 'active' and excluded.status = 'active' then now() else sync_schedules.next_run_at end,
      updated_at = now();
    get diagnostics v_affected = row_count;
  end if;

  return jsonb_build_object('affected', v_affected, 'action', 'synced',
    'orders', v_orders_on, 'payments', v_payments_on, 'push', v_push_on,
    'tables', v_tables_on, 'products', v_products_on, 'employees', v_employees_on);
end;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_sync_now(p_site_id bigint, p_integration text, p_sync_type text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_schedule sync_schedules; v_job_id uuid; v_idem text;
begin
  if not (
       (p_integration = 'clover'   and p_sync_type in ('fetch_open_orders', 'fetch_closed_orders', 'fetch_payments', 'push_orders'))
    or (p_integration = 'omnivore' and p_sync_type in ('fetch_recent_orders', 'fetch_tables', 'fetch_products', 'fetch_employees'))
  ) then
    raise exception 'invalid sync_type % for integration %', p_sync_type, p_integration using errcode = '22023';
  end if;

  if not exists (select 1 from site_integrations where site_id = p_site_id and provider = p_integration and type = 'pos' and active) then
    raise exception 'no active % integration for site %', p_integration, p_site_id using errcode = 'P0002';
  end if;

  select id into v_job_id from integration_jobs
   where site_id = p_site_id and integration = p_integration and job_type = p_sync_type
     and status in ('pending', 'running', 'retrying') limit 1;
  if v_job_id is not null then return v_job_id; end if;

  select * into v_schedule from sync_schedules
   where site_id = p_site_id and integration = p_integration and sync_type = p_sync_type limit 1;

  v_idem := 'manual:' || p_integration || ':' || p_site_id || ':' || p_sync_type
            || ':' || floor(extract(epoch from clock_timestamp()))::bigint;

  v_job_id := enqueue_job(
    p_site_id, 'pos_sync', p_sync_type, p_integration, v_idem,
    jsonb_build_object('schedule_id', v_schedule.id, 'cursor', v_schedule.last_cursor,
                       'config', coalesce(v_schedule.config, '{}'::jsonb), 'manual', true),
    1,
    jsonb_build_array(jsonb_build_object('step_name', p_sync_type, 'max_attempts', 3,
      'input', jsonb_build_object('schedule_id', v_schedule.id, 'cursor', v_schedule.last_cursor, 'manual', true))));
  return v_job_id;
end;
$function$;

insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
select si.site_id, 'omnivore', 'fetch_employees', 86400, 'disabled', now()
from site_integrations si
where si.provider = 'omnivore' and si.type = 'pos' and si.active
on conflict (site_id, integration, sync_type) do nothing;
