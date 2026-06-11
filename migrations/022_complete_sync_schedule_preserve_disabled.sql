-- Fix: a manual "sync now" (trigger_sync_now → handler → complete_sync_schedule)
-- was silently flipping a DISABLED schedule to ACTIVE, turning on 24h auto-sync the
-- user never enabled (and desyncing the UI toggle from the actual schedule). This
-- affected every sync_type (omnivore fetch_tables/fetch_products/fetch_employees,
-- clover, orders).
--
-- complete_sync_schedule now NEVER resurrects a disabled schedule; it still clears
-- error/paused back to 'active' on a successful recurring run (failure recovery).

CREATE OR REPLACE FUNCTION public.complete_sync_schedule(p_schedule_id uuid, p_cursor text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql
AS $function$
begin
  update sync_schedules
  set last_cursor = case
        when p_cursor is null then last_cursor
        when last_cursor is null then p_cursor
        when p_cursor ~ '^[0-9]+$' and last_cursor ~ '^[0-9]+$'
          then greatest(p_cursor::numeric, last_cursor::numeric)::text
        else p_cursor
      end,
      consecutive_failures = 0,
      last_error           = null,
      -- preserve 'disabled' (manual run on an off schedule must not enable auto-sync);
      -- any other status (error/paused) → active on success.
      status               = case when status = 'disabled' then status else 'active'::schedule_status end,
      updated_at           = now()
  where id = p_schedule_id;
end;
$function$;

-- Repair the schedules wrongly activated by manual syncs before this fix: any omnivore
-- schedule whose gating config flag is false should be disabled.
update sync_schedules s
set status = 'disabled', updated_at = now()
from site_integrations si
where si.site_id = s.site_id and si.provider = 'omnivore' and si.type = 'pos' and si.active
  and s.integration = 'omnivore'
  and s.status = 'active'
  and coalesce((si.config ->> (case s.sync_type
        when 'fetch_tables'        then 'syncTablesAutomatically'
        when 'fetch_products'      then 'syncProductsAutomatically'
        when 'fetch_employees'     then 'syncEmployeesAutomatically'
        when 'fetch_recent_orders' then 'syncOrdersAutomatically'
      end))::boolean, false) = false;
