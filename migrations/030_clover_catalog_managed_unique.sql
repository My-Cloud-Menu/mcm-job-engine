-- clover-bidi (ADDITIVE): one Clover-managed POS catalog per site. Makes syncCloverPosCatalog's
-- find-then-insert concurrency-safe (parity with the catalog map tables): two concurrent syncs
-- can no longer create two `cloverManaged` catalog rows for the same site — the second insert
-- hits 23505 and the handler adopts+updates the existing one. Partial (only the managed row).
-- PROD NOTE: apply with CREATE UNIQUE INDEX CONCURRENTLY (outside a txn) on the shared table.

CREATE UNIQUE INDEX IF NOT EXISTS ux_catalogs_site_clovermanaged
  ON public.catalogs (site_id)
  WHERE additional_properties->>'cloverManaged' = 'true';
