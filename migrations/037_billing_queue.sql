-- 037_billing_queue.sql
-- Cola dedicada 'billing' para el módulo de Suscripciones (`subs_*`).
-- Handlers previstos: subs.apply_payment, subs.invoice_period, subs.charge_period,
-- subs.dunning_advance, subs.harvest_instrument, subs.dispatch_notifications, subs.reconcile,
-- subs.external_sync. En la fase 2 sólo existe subs.noop (humo).
--
-- Cola propia para que el dinero recurrente no espere detrás de la inyección al POS, y para poder
-- acotar su concurrencia por separado: cada job llama a una edge function que COBRA.

alter table public.integration_jobs drop constraint integration_jobs_queue_name_check;
alter table public.integration_jobs add constraint integration_jobs_queue_name_check
  check (queue_name in ('pos_injection','pos_sync','notifications','webhooks','order_actions','printing','billing'));

insert into public.integration_concurrency_limits (queue_name, integration, max_concurrency, notes)
values ('billing', 'subs', 10, 'Cobros recurrentes de suscripciones: concurrencia global acotada (es dinero)')
on conflict (queue_name, integration, site_id) do nothing;
