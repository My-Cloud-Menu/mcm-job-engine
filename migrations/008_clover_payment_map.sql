-- ============================================================
-- 008_clover_payment_map.sql
-- Mapeo de pagos Clover ↔ MCM. Sirve para:
--   • dedup duro del pull de pagos (UNIQUE site_id, clover_payment_id)
--   • anti-loop: reconocer pagos que MCM inyectó (external_payment_id)
--   • reflejar voids/refunds posteriores (voided, total_refunded, modified_time)
-- ============================================================

create table if not exists clover_payment_map (
  id              uuid primary key default gen_random_uuid(),
  site_id         bigint not null,
  clover_payment_id text not null,
  mcm_payment_id  bigint,
  external_payment_id text,
  voided          boolean not null default false,
  total_refunded  numeric not null default 0,
  modified_time   bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (site_id, clover_payment_id)
);

create index if not exists ix_clover_pay_map_site on clover_payment_map (site_id);
create index if not exists ix_clover_pay_map_mcm  on clover_payment_map (site_id, mcm_payment_id);

-- RLS: solo service_role (el worker). Sin políticas → authenticated/anon denegados.
alter table clover_payment_map enable row level security;

-- keep updated_at fresh
create or replace function tg_clover_payment_map_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists clover_payment_map_touch on clover_payment_map;
create trigger clover_payment_map_touch
  before update on clover_payment_map
  for each row execute function tg_clover_payment_map_touch();
