-- ============================================================
-- 025_order_actions_queue.sql
-- Cola dedicada 'order_actions' para acciones de órdenes en el job-engine.
-- Primer handler: delivery.dispatch (Uber Direct / in-house).
-- Pensada para alojar a futuro: sms/email/otras acciones disparadas por la orden.
-- ============================================================

alter table public.integration_jobs drop constraint integration_jobs_queue_name_check;
alter table public.integration_jobs add constraint integration_jobs_queue_name_check
  check (queue_name in ('pos_injection','pos_sync','notifications','webhooks','order_actions'));

insert into public.integration_concurrency_limits (integration, max_concurrency, notes)
values ('delivery', 50, 'Delivery dispatch (Uber Direct) global concurrency limit')
on conflict (queue_name, integration, site_id) do nothing;
