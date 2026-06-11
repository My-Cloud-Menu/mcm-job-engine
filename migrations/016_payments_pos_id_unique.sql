-- ============================================================
-- 016_payments_pos_id_unique.sql
-- Hardening de concurrencia (Fix 1, CRÍTICO). El pull de pagos Clover
-- (`upsert-payments.ts`) hacía SELECT-then-INSERT sin constraint: dos jobs de
-- `fetch_payments` concurrentes (mismo site, solapados) creaban DOS filas
-- `payments` para el MISMO pago Clover → doble conteo + doble inyección a
-- Omnivore (doble cargo).
--
-- `pos_id` = id del pago en el POS externo (Clover payment id en el pull; ids de
-- otros POS son de espacios distintos). Es único por pago real → un índice UNIQUE
-- parcial es correcto y hace el INSERT idempotente bajo cualquier concurrencia.
--
-- IMPORTANTE: el índice debe ser **NO-parcial**. PostgREST/Postgres NO puede usar
-- `ON CONFLICT (site_id,pos_id)` (el .upsert) contra un índice PARCIAL → error 42P10
-- ("there is no unique or exclusion constraint matching the ON CONFLICT spec") y el
-- pull de pagos falla en cada corrida. Un unique normal sobre (site_id,pos_id) sirve:
-- los `pos_id` NULL siguen permitidos (NULLs distintos por defecto), igual que los
-- índices de `orders` (orders_site_clover_pos_id_uniq / orders_site_omnivore_pos_id_uniq),
-- que usan exactamente este patrón con upsert.
--
-- PROD: verificar 0 duplicados antes y usar CREATE UNIQUE INDEX CONCURRENTLY
-- fuera de transacción:
--   select site_id, pos_id, count(*) from payments where pos_id is not null
--     group by 1,2 having count(*)>1;   -- debe dar 0 filas
--   create unique index concurrently payments_site_pos_id_uniq
--     on payments (site_id, pos_id);
-- (Dev: 0 duplicados verificado → el índice se crea limpio aquí.)
-- ============================================================

drop index if exists payments_site_pos_id_uniq;
create unique index if not exists payments_site_pos_id_uniq
  on public.payments (site_id, pos_id);
