-- ============================================================
-- 026_printing_queue.sql
-- Cola dedicada 'printing' para el módulo unificado de impresión (MCM Print Platform).
-- Handlers: printing.dispatch_qz, printing.dispatch_star (push), printing.watchdog_epson (pull).
-- Las tablas de dominio (print_jobs/printers/print_job_events) viven en mcm-edge-functions
-- (migración init08_printing_tables); aquí solo se habilita la cola en el engine.
-- ============================================================

alter table public.integration_jobs drop constraint integration_jobs_queue_name_check;
alter table public.integration_jobs add constraint integration_jobs_queue_name_check
  check (queue_name in ('pos_injection','pos_sync','notifications','webhooks','order_actions','printing'));

-- Concurrency global para 'printing'. Epson es pull (no usa workers); QZ serializa por socket en el
-- gateway; el límite acota los dispatch push (QZ/Star) en paralelo.
insert into public.integration_concurrency_limits (queue_name, integration, max_concurrency, notes)
values ('printing', 'printing', 20, 'Print dispatch (QZ/Star) global concurrency limit')
on conflict (queue_name, integration, site_id) do nothing;
