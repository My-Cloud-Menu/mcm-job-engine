-- ============================================================
-- 007_ensure_sync_schedules.sql
-- RPC que provisiona o deshabilita filas en sync_schedules
-- cuando el usuario activa/desactiva sync_orders en la integración.
-- ============================================================

-- Mapa interno de integración → sync_types + intervalos (segundos):
--   clover   → fetch_open_orders (60s) + fetch_closed_orders (300s)
--   omnivore → fetch_recent_orders (60s)
-- Integraciones sin sync (uber-eats, qz, evertec, mcm-reservations, etc.)
-- reciben no-op sin error.

create or replace function ensure_sync_schedules(
  p_site_id    bigint,
  p_integration text,
  p_enabled     boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_affected int := 0;
begin
  -- No-op para integraciones que no tienen sync (retorna sin error)
  if p_integration not in ('clover', 'omnivore') then
    return jsonb_build_object('affected', 0, 'action', 'noop');
  end if;

  if p_enabled then
    -- Activa o crea las filas necesarias para el (site, integration).
    -- ON CONFLICT solo toca status y updated_at; conserva last_cursor,
    -- consecutive_failures e interval_seconds para no perder progreso
    -- al reactivar un schedule existente.
    if p_integration = 'clover' then
      insert into sync_schedules (site_id, integration, sync_type, interval_seconds, status, next_run_at)
      values
        (p_site_id, 'clover', 'fetch_open_orders',   60,  'active', now()),
        (p_site_id, 'clover', 'fetch_closed_orders', 300, 'active', now())
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
    -- Deshabilita todas las filas del (site, integration).
    -- Conserva last_cursor para que al reactivar reanude desde donde quedó.
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

-- Accesible a usuarios autenticados del dashboard.
-- La primera línea de defensa es la RLS de site_integrations:
-- solo puede llegar aquí un usuario que ya pudo guardar la integración.
grant execute on function ensure_sync_schedules(bigint, text, boolean) to authenticated;

comment on function ensure_sync_schedules is
  'Provisiona (enabled=true) o deshabilita (enabled=false) las filas de sync_schedules '
  'para un (site_id, integration). Idempotente. Conserva last_cursor al reactivar. '
  'Integrations sin sync retornan noop sin error. '
  'Registrar nuevas integrations con sync en el mapa interno de esta función.';
