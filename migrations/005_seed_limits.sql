-- ============================================================
-- 005_seed_limits.sql
-- Default concurrency limits per integration
-- ============================================================

insert into integration_concurrency_limits (integration, max_concurrency, notes) values
  ('omnivore', 20,  'Omnivore global concurrency limit'),
  ('clover',   30,  'Clover global concurrency limit'),
  ('twilio',   100, 'Twilio global concurrency limit'),
  ('sendgrid', 200, 'SendGrid global concurrency limit')
on conflict (queue_name, integration, site_id) do nothing;
