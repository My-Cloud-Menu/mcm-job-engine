-- clover-bidi (ADDITIVE): partial UNIQUE indexes on (site_id, cloverId) for every catalog table
-- the Clover sync writes. This makes the check-then-insert catalog sync CONCURRENCY-SAFE
-- (parity with orders' orders_site_clover_pos_id_uniq): if two sweeps race — e.g. the
-- recover_stuck_jobs reaper re-dispatches a still-alive slow sync — the second INSERT hits
-- 23505 and the handler adopts the existing row (insertOrAdopt) instead of creating a duplicate.
-- Also prevents "zombie duplicate" rows. Partial (WHERE cloverId IS NOT NULL) so it only covers
-- Clover-synced rows and never conflicts with Omnivore-synced (omnivoreId) or hand-created rows.
--
-- Verified 0 existing duplicate cloverIds before creating (else the index build would fail).
-- PROD NOTE: apply each with CREATE UNIQUE INDEX CONCURRENTLY (outside a txn) to avoid a write
-- lock on these large shared tables; the plain form below is for the DEV migration runner.

CREATE UNIQUE INDEX IF NOT EXISTS ux_products_site_cloverid
  ON public.products (site_id, (additional_properties->>'cloverId'))
  WHERE additional_properties->>'cloverId' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_site_cloverid
  ON public.categories (site_id, (additional_properties->>'cloverId'))
  WHERE additional_properties->>'cloverId' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ingredients_site_cloverid
  ON public.ingredients (site_id, (additional_properties->>'cloverId'))
  WHERE additional_properties->>'cloverId' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ingredients_groups_site_cloverid
  ON public.ingredients_groups (site_id, (additional_properties->>'cloverId'))
  WHERE additional_properties->>'cloverId' IS NOT NULL;
