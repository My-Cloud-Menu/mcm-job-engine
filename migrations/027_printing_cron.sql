-- ============================================================
-- 027_printing_cron.sql
-- Cron + triggers de fiabilidad de la cola 'printing'. El engine es dueño de TODO el cron de jobs.
-- (Las tablas/RPCs de print viven en mcm-edge-functions/migrations/init08; misma DB.)
-- ============================================================

create extension if not exists pg_cron;

-- Watchdog del pull Epson (dueño del timeout): dispatched sin SetResponse > timeout → queued/dead_letter;
-- + marca offline las Epson con heartbeat viejo. Corre cada minuto, como recover_stuck_jobs.
select cron.schedule(
  'printing-reap-dispatched',
  '* * * * *',
  $$ select public.sdp_reap_dispatched() $$
);

-- Espejo: cuando un job de la cola 'printing' (QZ/Star) cae a dead_letter en el engine, reflejarlo en
-- print_jobs (el handler no sabe que fue su último intento; el engine sí).
create or replace function public.printing_mirror_dead_letter() returns trigger
language plpgsql security definer set search_path to 'pg_catalog','public' as $$
begin
  if new.queue_name = 'printing' and new.status = 'dead_letter'
     and old.status is distinct from 'dead_letter' then
    update public.print_jobs
       set status = 'dead_letter', date_updated = now()
     where engine_job_id = new.id and status not in ('printed', 'cancelled');
  end if;
  return new;
end $$;
drop trigger if exists tg_printing_mirror_dead_letter on public.integration_jobs;
create trigger tg_printing_mirror_dead_letter after update on public.integration_jobs
  for each row execute function public.printing_mirror_dead_letter();

-- Alerta operacional cuando un print_job cae a dead_letter. QZ/Star ya alertan vía el dead_letter del
-- engine (dead_letter_jobs → enqueue_alert); aquí cubrimos Epson (pull, sin job de engine) para no perder
-- visibilidad de "ticket de cocina que no se imprimió".
create or replace function public.printing_alert_dead_letter() returns trigger
language plpgsql security definer set search_path to 'pg_catalog','public' as $$
begin
  if new.status = 'dead_letter' and old.status is distinct from 'dead_letter'
     and new.transport = 'epson_sdp' then
    perform enqueue_alert(
      'print_dead_letter:' || new.id::text,
      'warning'::alert_severity,
      'print_dead_letter',
      'Ticket de cocina sin imprimir (Epson)',
      format('Print job %s del site %s no se imprimió: %s',
             new.id, new.site_id, coalesce(new.error_code, 'desconocido')),
      jsonb_build_object('print_job_id', new.id, 'printer_id', new.printer_id, 'error_code', new.error_code),
      new.site_id,
      'printing'
    );
  end if;
  return new;
end $$;
drop trigger if exists tg_printing_alert_dead_letter on public.print_jobs;
create trigger tg_printing_alert_dead_letter after update on public.print_jobs
  for each row execute function public.printing_alert_dead_letter();
