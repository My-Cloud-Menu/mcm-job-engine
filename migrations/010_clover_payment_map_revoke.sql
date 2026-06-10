-- ============================================================
-- 010_clover_payment_map_revoke.sql
-- Defensa en profundidad: clover_payment_map es interna del worker
-- (service_role). Quitar los grants por defecto a anon/authenticated
-- (los advisors de Supabase los marcan como tabla expuesta vía pg_graphql).
-- RLS ya está habilitado sin políticas; esto elimina el grant explícito.
-- ============================================================

revoke all on table clover_payment_map from anon;
revoke all on table clover_payment_map from authenticated;
