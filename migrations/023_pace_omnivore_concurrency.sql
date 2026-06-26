-- Fix (rush stability): pace Omnivore injection concurrency.
--
-- Auditoría 2026-06-13 (audits/2026-06-13/omnivore-injection-stress-audit.md): bajo 50
-- inyecciones simultáneas con el límite global de omnivore en 20, el POS (Aloha) se saturó
-- (`pos_offline`) → el circuit breaker abrió y difirió jobs (sin duplicar, pero con lag).
-- Con la concurrencia paceada el volumen drena limpio (50/50, 0 duplicados).
--
-- 20 inyecciones simultáneas = hasta ~60 llamadas en ráfaga al POS y supera el umbral del
-- breaker (10 fallos/60s) en un mal momento. 8 mantiene headroom bajo ese umbral y pacea el
-- POS sin sacrificar throughput normal. `claim_next_job` honra este límite global de omnivore.
-- Tunable por POS vía una fila con `site_id` si una location necesita otro valor.

update public.integration_concurrency_limits
set max_concurrency = 8,
    notes = 'Omnivore global concurrency limit (paced 20→8 para no saturar el POS en rush — audit 2026-06-13)',
    updated_at = now()
where integration = 'omnivore' and site_id is null;
