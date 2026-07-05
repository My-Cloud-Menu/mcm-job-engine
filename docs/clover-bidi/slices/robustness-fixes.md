# Robustez del sync de catálogo — hallazgos (revisión adversarial) → fixes

Revisión multi-agente (5 lentes: concurrencia, idempotencia, archive, mapping, tenant; verificación adversarial). Hallazgos confirmados y su estado tras los arreglos. Todo verificado con tsc + unit tests + sandbox.

| # | Sev | Hallazgo | Fix aplicado | Verificación |
|---|---|---|---|---|
| 1 | HIGH | **Soft-archive podía borrar catálogo vivo**: `complete=true` es falso-positivo en página corta/vacía o en el cap de offset de Clover (>1000 items) → archivaba todo lo "ausente". | `archiveIsSafe()` — nunca archiva si `!complete`, si `present==0`, o si el shrink supera `max(10, 15%)` del catálogo mapeado (fetch degradado → skip + `clover_archive_skipped_suspicious`). Aplicado a categorías y productos. | unit: "archive FLOOR GUARD refuses to wipe" + "allows normal small shrink" |
| 2 | MEDIUM | **Update perdido**: `is_taxable`/`sku`/`description` se escribían pero NO estaban en la detección de cambios → editar solo esos campos en Clover se ignoraba (riesgo de tax). | Añadidos al `select` y al predicado `changed`. | tsc; sandbox idempotente |
| 3/13 | HIGH* | **Duplicación concurrente**: check-then-insert sin constraint único; `recover_stuck_jobs` puede re-correr un sync lento aún vivo (lease expira) → 2 ejecuciones concurrentes insertan el catálogo 2×. | **Migración 029**: índices únicos parciales `(site_id, cloverId)` en products/categories/ingredients/ingredients_groups + `insertOrAdopt()` (23505 → adopta la fila existente). | **sandbox: 2 syncs concurrentes → 114/20/90/10, dup_delta 0** + unit "adopts on 23505" |
| 15 | — | **Zombies duplicados** (byClover conserva solo 1 por cloverId). | Resuelto por el índice único (imposibilita crear el 2º). | — |
| 16 | — | **Comparación order-sensitive** de `ingredients_groups.ingredients` → rewrites espurios si Clover reordena. | `refKey()` compara ids ordenados numéricamente. | tsc; sandbox idempotente (modifiers skipped) |
| 18 | — | **Modificador con nombre null** → updates espurios perpetuos. | Normalizado `mName = m.name ?? ''` en write + compare. | tsc |
| 7 | — | **`maxAllowed=0` (ilimitado)** → MCM `maximum=0` (posible "0 permitidos"). | `maximum = maxAllowed>0 ? maxAllowed : null` (null = sin tope). | tsc |
| 9 | — | **item-stock ignora `hidden`** → item oculto en Clover podía leerse instock. | `available = item.available!==false && item.hidden!==true`. | tsc |
| 17 | — | **draft-but-instock no se republicaba** (gate solo por stock_status). | Gate por stock_status **y** status; republica; no resucita archivados. | tsc |
| 10 | — | **Items de precio variable/peso** (priceType VARIABLE/PER_UNIT) sync como $0. | Se guarda `additional_properties.cloverPriceType` (el $0 es correcto para precio-al-vender; ya no es silencioso). | tsc |

\* Sev original del hallazgo LOW por probabilidad (requiere expiración de lease estando vivo), pero el fix es la garantía de integridad definitiva (paridad con órdenes).

## Deferred / documentado (BLOQUEOS.md)
- **Modificadores sin soft-archive**: un modifier group borrado en Clover permanece en MCM. Follow-up (menor riesgo; añadir archive con el mismo floor guard).
- **[SEGURIDAD, PRE-EXISTENTE]** `ensure_sync_schedules` y `trigger_sync_now` son `SECURITY DEFINER` con `GRANT ... authenticated` y **sin `has_location_access`** → un usuario autenticado podría provisionar/disparar syncs de **cualquier `site_id`**. Viene de la migración 021 (mi mig 028 la recreó byte-for-byte, sin introducir ni corregir la postura). Recomendación: añadir un check `has_location_access(p_site_id)` en una revisión de seguridad dedicada (no tocado esta noche por ser código compartido de producción y fuera del scope aditivo).
- **`>1000 items`**: paginación por offset (cap+log); el floor guard evita el borrado, pero un catálogo enorme necesita cursor por `modifiedTime` (follow-up).
