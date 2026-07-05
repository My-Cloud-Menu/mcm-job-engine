# CHANGELOG nocturno — Clover ↔ MCM bidireccional (corrida autónoma)

> Registro incremental de cada cambio conceptual (en lugar de commits — decisión del usuario: **cero commits**).
> Todo en el working tree de las ramas actuales (`audit/delivery-overnight` en job-engine/edge/dashboard; `orderandpay` no se toca).
> Fecha de la corrida: 2026-07-02.

## Convenciones
- **Aditivo puro**: no se altera firma ni contrato de código de producción (Omnivore / Clover previo).
- **Multi-tenant**: toda query nueva por `site_id`; toda tabla nueva con RLS service-role-only.
- **Secretos**: el `apiKey` de Clover nunca se imprime ni se escribe en ningún repo; vive solo en el scratchpad de sesión.

---

## Fase 0 — Smoke test, host gate, provisión (COMPLETA)

- **NEW** `docs/clover-bidi/` (+ `slices/`, `evidence/`, `scripts/`) — carpeta de trabajo/reportes/evidencia.
- **EDIT** `.gitignore` (job-engine) — añadido `.env.clover*` y `docs/clover-bidi/evidence/*.secret` como defensa de secretos (el `.env.clover.sandbox` NO estaba cubierto antes; corregido). Cambio aditivo/protectivo.
- **NEW** `docs/clover-bidi/scripts/00-smoke.cjs` — lee el config Clover de DEV site 25512412 vía PostgREST (service_role), resuelve el host válido, smoke-test de merchant/tenders/items. Usa `fetch` nativo (Node 24), sin deps. Token nunca impreso; escrito solo al scratchpad.
- **DEV data** (MCP execute_sql, ref `blbelbdvykpvbeqbjqom`):
  - `sites` A `99990001` (`clover-sandbox-test-a`) + B `99990002` (`clover-sandbox-test-b`), org 6, active, PR. Idempotente (`ON CONFLICT (id) DO NOTHING`).
  - `site_integrations` de A: clon del row Clover de 25512412 (merchant `7ES0TRRRYJCY1`, host `sandbox.dev.clover.com`), `active=true`. B queda sin Clover (control de aislamiento).
- **Baseline `npm test` (pre-cambios, 2026-07-02):** `123 passed / 6 failed` (3 files). Fallas **pre-existentes en la rama, ajenas a Clover**: `circuit-breaker.test.ts` (file), `omnivore-convert-order.test.ts` (2), `omnivore-payment-injection.test.ts` (4) — mocks fluidos de Supabase insuficientes para cadenas `.eq()` largas. **Gate de no-regresión = exactamente estas 6, cero nuevas, todos los tests Clover verdes.**
- **Resultado smoke:** ambos hosts (`sandbox.dev.clover.com` y `apisandbox.dev.clover.com`) autentican (200); se usa el configurado `sandbox.dev.clover.com`. Merchant "MCM Restaurant Test", 15 tenders (incluye tender externo **"MCM" `4QPPVE0NFNBN4`** ya existente = `defaultTenderId`), items accesibles. Evidencia redacted en `evidence/00-smoke.json`.

## Slice A — Fundaciones (COMPLETA)

- **NEW** `src/handlers/clover/region.ts` — `resolveCloverBaseUrl` (apiUrl gana → region mapea → default). Aditivo.
- **EDIT (aditivo, retro-compatible)** `src/handlers/clover/client.ts` — baseURL delega a `resolveCloverBaseUrl`; `CloverConfigSchema` gana `region` + flags catálogo `.optional()` (z.object no-strict → sin romper parse de configs prod). Firma sin cambios.
- **NEW** `tests/unit/clover-region.test.ts` (7 tests, verdes). `tsc --noEmit` limpio.
- Tender externo "MCM" verificado (ya existe); OAuth diferido (BLOQUEOS). Reporte `slices/A.md`.

## Slice B — Catálogo inbound (COMPLETA)

- **NEW** `src/handlers/clover/sync/{rate-limit,catalog-sync,modifier-sync,fetch-products,fetch-employees,fetch-item-stock}.ts` — sync Clover→MCM de categorías/productos/item_stock(86)/modificadores/empleados, keyed por `cloverId`, soft-archive (G9), token-bucket (G1), paginación cap+log (G6), gate por flags default OFF.
- **EDIT aditivo** `load-handlers.ts` (3 imports).
- **NEW** `migrations/028_clover_catalog_schedules.sql` — extiende `ensure_sync_schedules`/`trigger_sync_now` (omnivore byte-for-byte) + backfill disabled + sync-log tables (RLS). Aplicada a DEV. Regresión omnivore OK.
- **Fix** idempotencia: comparar precio en céntimos enteros (PostgREST numeric→number vs toFixed string).
- **NEW** tests `clover-catalog-sync.test.ts` (9). Sandbox: 20 cats/114 prods/90 ings/10 groups; idempotente; 86 round-trip; soft-archive; aislamiento site B=0. Suite 139/6 (6 pre-existentes). Reporte `slices/B.md`.
- **DEV data:** site A flags `sync_products/employees/item_stock=true`, schedules activos; site B sin clover (control).
- **Scripts:** `docs/clover-bidi/scripts/{B-probe,B-run.ts,B-toggle}.cjs` (recon + harness + 86 toggle).

## Slice C (inbound) + F (pagos) + simulación inbound (VERIFICADO)

- **NEW** `e2e-clover.ts` (root) — simulación de jornada: 24 órdenes / 4 meseros / items reales, ~12 pagadas; corre los handlers de pull reales (`fetch_open_orders`/`fetch_closed_orders`/`fetch_payments`) contra site A.
- **Resultado:** 24/24 órdenes reconciliadas al centavo (0 mismatch), 12/12 pagos ligados (`clover_payment_map.mcm_payment_id`), idempotente, aislamiento site B=0, cleanup. Evidencia `evidence/e2e-clover-sim.json`. Reporte `slices/C-F-simulation.md`.
- **EDIT aditivo (G7)** `src/handlers/clover/sync/fetch-payments.ts` — clamp far-future en el avance del cursor monótono (`Math.min(advanced, now()+5min)`); previene envenenamiento del watermark. Defensivo, no altera el flujo normal.
- Refund/void live: HTTP 405 en sandbox (tender externo offline no refundable por API) → reportado con transparencia; lógica cubierta por `clover-pull.test.ts`. Documentado en BLOQUEOS.

## Slice D — Órdenes outbound (VERIFICADO)

- **NEW** `docs/clover-bidi/scripts/D-outbound.ts` — conduce `clover.create_order` + `clover.reconcile_items` reales contra sandbox.
- **Resultado:** 5/5 órdenes creadas con line items + total exacto al centavo; idempotencia adopt=true/same_id=true (dedup primario `clover_ticket_id`). Reporte `slices/D.md`, evidencia `evidence/D-outbound.json`. Sin cambios de código (verificación de flujo existente).
- **Hallazgos (documentados, edge no tocado):** externalReferenceId cap 12 chars; bulk_line_items requiere price; lookup secundario por externalRef con lag de indexado (primario robusto).

## Slice E — Modificación bidi + modificadores nativos + spike mesas

- **NEW** `docs/clover-bidi/scripts/E-modifications-spike.cjs` — spike de `/modifications`.
- **Hallazgo:** `/modifications` FEASIBLE pero Clover **NO dedupea** (doble-POST → 2 mods) → **P1.6 confirmado**. Cablear requiere idempotencia MCM-side + guard G5 + tocar el edge → **deferred** (se mantiene fallback de nota, producción intacta).
- Bidireccional de órdenes: cubierto por reconcile (out, Slice D) + pull (in, Slice C) + guard de orden pagada→supplemental (unit tests). Sin cambios de código.
- Mesas: spike P1.5 resuelto (órdenes Clover sin `table`/`employee`) → floor-only/deferred. Reporte `slices/E.md`.

## Cierre (Fase final)

- **Docs:** `01-investigacion.md`, `02-endpoints-verificados.md`, `03-gap-analysis.md`, `04-diseno.md`, `99-reporte-final.md` escritos.
- **Gate de no-regresión final:** `tsc --noEmit` limpio; suite **139 passed / 6 failed** (las 6 pre-existentes de Omnivore, cero nuevas). Regresión G2 OK.
- **Higiene:** rama `audit/delivery-overnight` (sin cambios de rama, sin commits); cero archivos de secretos en el repo (token solo en scratchpad); scan de fugas limpio.
- **Ediciones a código existente (aditivas, documentadas):** `.gitignore` (+`.env.clover*`), `client.ts` (baseURL→resolver retro-compatible + flags opcionales), `fetch-payments.ts` (clamp far-future), `load-handlers.ts` (3 imports). **Edge de producción NO tocado.**
- **Memoria:** `project_clover_bidi_extension.md` + índice MEMORY.md.

## Hardening extra de edge cases (`G-edgecases.ts`)

- **Concurrencia (P2.7):** 4 `fetch_open_orders` en paralelo → cada orden con exactamente **1 fila MCM** (cero duplicados), garantizado por el índice único `orders_site_clover_pos_id_uniq (site_id, clover_pos_id)` (confirmado) + `ON CONFLICT ignoreDuplicates`.
- **Update path:** editar orden Clover (nuevo total + línea extra) → re-pull → total MCM actualizado al centavo, sigue en 1 fila (no duplica). Evidencia `evidence/G-edgecases.json`.

## Anti-duplicación exhaustiva (`H-dedup.ts`) — `ALL_DEDUP_OK: true`

- **S1 outbound→inbound (WS-6/F12):** push a Clover → pull → 1 sola fila (misma orden actualizada por `clover_ticket_id`, no duplica la que MCM creó).
- **S2 concurrencia:** 8 pulls paralelos / 5 órdenes → 1 fila cada una.
- **S3 pulls repetidos (6×):** siempre 1.
- **S4 concurrencia de pagos:** 4 `fetch_payments` paralelos → 1 `clover_payment_map` row por pago.
- Respaldo: índices únicos `orders_site_clover_pos_id_uniq`, `clover_payment_map(site_id,clover_payment_id)`, `payments(site_id,pos_id)` + lookup dual-id `.or(clover_pos_id,clover_ticket_id)`. Reporte `slices/H-dedup.md`, evidencia `evidence/H-dedup.json`.
- **Verificación integral final:** tsc CLEAN; suite 139/6 (6 pre-existentes); working tree solo aditivo; site A limpiado (residual payments/map/orders purgados, catálogo 20/114/90/10 conservado); site B aislado (0 órdenes).

## Robustez de catálogo (revisión adversarial multi-agente → fixes) — `slices/robustness-fixes.md`

- **EDIT `catalog-sync.ts`:** `archiveIsSafe()` (floor guard — nunca borra catálogo vivo en sweep degradado/>1000, HIGH); detección de cambios ampliada (is_taxable/sku/description, MEDIUM); `insertOrAdopt()` (23505 → adopta, concurrency-safe); item-stock considera `hidden` + republica draft-instock; flag `cloverPriceType` para precio variable.
- **EDIT `modifier-sync.ts`:** comparación order-insensitive (`refKey`), guard de nombre null, `maxAllowed=0`→null, `insertOrAdopt`.
- **NEW `migrations/029_clover_catalog_dedup_indexes.sql`:** índices únicos parciales `(site_id, cloverId)` en products/categories/ingredients/ingredients_groups. Aplicada a DEV (0 dups previos). **Verificado: 2 syncs concurrentes → 114/20/90/10, dup_delta 0.**
- **NEW tests:** `clover-order-mapper.test.ts` (4), `clover-catalog-sync.test.ts` +3 (archive floor, normal shrink, adopt-23505). Suite 146/6.
- Pre-existente [SEGURIDAD] documentado: `ensure_sync_schedules`/`trigger_sync_now` SECURITY DEFINER + authenticated sin `has_location_access` (BLOQUEOS).

## Compatibilidad /pos-order — `slices/I-pos-compat.md`

- **Front 1 (menú):** el catálogo sincronizado NO aparecía en el POS (requiere fila `catalogs` publicada; no es específico de Clover). **NEW** `syncCloverPosCatalog` (flag `autoManageCloverCatalog`, default OFF) mantiene un catálogo "Clover (auto)". **Verificado: `get-menus` devuelve 104/114 productos** (10 sin categoría por diseño).
- **Front 2 (render):** **EDIT `order-mapper.ts` + `upsert-orders.ts`** — `attributes[]`+`additional_properties.modifiers` desde `lineItems.modifications` (modificadores ahora renderizan) + `product_id` mapeado vía `cloverId` a producto MCM (acciones interactivas/86). **Verificado (K):** modifier_rendered + product_id_resolved_to_mcm. Caveat: 1 re-sync único de órdenes abiertas al desplegar.
- POS/O&P sin cambios de código.

## Follow-ups completados (#1–#4)

- **#2 Fallback sin-categoría** — `syncCloverPosCatalog` añade los productos sin categoría al `products_id` del catálogo auto. **Verificado: `get-menus` 104→114 productos.**
- **#1 Soft-archive de modificadores** — `syncCloverModifiers` archiva ingredients/ingredients_groups ausentes de Clover con el mismo floor-guard. **Verificado: grupo fantasma → draft+cloverArchived (no borrado).**
- **#3 Paginación por cursor** — `fetchAllCloverElements` modo cursor por **`id`** (`orderBy=id&filter=id>X`, `>` estricto — el `modifiedTime` fallaba por empates: los 114 items comparten modifiedTime). Usado en `/items` (fetch-products + fetch-item-stock). **Verificado: 114 items vía cursor** (arreglada la regresión); unit tests (sweep + stuck-guard). >1000 real pendiente de un merchant grande.
- **#4 Modificadores nativos outbound** — `reconcile_items` (flag `cloverNativeModifiers`, default OFF) adjunta modifications a cada line item creado; **idempotente por construcción** (el DELETE+RECREATE de reconcile impide acumulación). Fix: la respuesta de `bulk_line_items` es un **array plano** (no `{elements}`). **Verificado (L): modifier adjunto + sin acumulación tras re-reconcile.**
- **NEW** flags de config: `cloverNativeModifiers`. **NEW** scripts `L-native-modifiers.ts`. Tests: +2 cursor. Suite **148/6**.

## 2ª ronda de pruebas exhaustivas — bugs encontrados y arreglados

Pruebas de casos límite + revisión adversarial de los 4 features → **5 bugs reales corregidos**:

- **[modifiers resurrect]** un modificador/grupo archivado que reaparece en Clover **no se des-archivaba** (el loop no reseteaba `cloverArchived`). Fix: reset `cloverArchived:false` + status/stock restaurados + incluido en la detección de cambios. **Verificado:** grupo archivado manualmente → des-archivado en el sync.
- **[native modifiers — correlación, HIGH]** la correlación línea↔modificador era por **índice del bulk**, pero `bulk_line_items` **NO garantiza el orden** de respuesta → modificadores en la línea equivocada (multi-línea mixta). Fix: correlación por **(name, price)**. **Verificado (M):** 3 líneas mixtas [1/0/2 mods] correctas.
- **[native modifiers — retry, HIGH]** un fallo transitorio de `/modifications` se tragaba y el hash se persistía como éxito → nunca reintentaba (drop silencioso). Fix: clasificar con `mapCloverError`; si transitorio → throw retryable (reintenta el reconcile); permanente (400) → best-effort.
- **[native modifiers — DELETE dup, MEDIUM]** un DELETE fallido (tragado) acumulaba líneas+modificaciones duplicadas en retry. Fix: con `cloverNativeModifiers`, un DELETE fallido lanza retryable (reconcile limpio). Path legacy sin cambios.
- **[catálogo managed dup, MEDIUM]** `syncCloverPosCatalog` find-then-insert sin guard → 2 syncs concurrentes podían crear 2 catálogos managed. Fix: **migración 030** índice único parcial `catalogs(site_id) WHERE cloverManaged` + manejo 23505 (adopt). **Verificado:** insert de 2º managed bloqueado.
- **[cursor 6000 boundary, LOW]** exactamente 6000 items no-borrados → falso `complete:false` → salta el archive de ese sweep (conservador, sin pérdida). Documentado (BLOQUEOS).
- **NEW** scripts `M-native-mod-edge.ts`. Tests unitarios +2 cursor. **Verificado:** flag OFF → sin modificadores nativos. Suite 148/6, tsc limpio.

## Simulación alto volumen + caza de bugs (3ª ronda)

- **Regresión completa verde** tras todos los cambios: unit suite, catálogo idempotente, **inbound N=50 (50/50 al centavo, 25/25 pagos ligados, idempotente, aislado)**, outbound 6/6+adopt, **dedup ALL_OK (4 vectores)**, native modifiers ALL_OK, POS render OK.
- **[BUG REAL, HIGH — encontrado y arreglado]** `reconcile_items` enviaba TODOS los line items en un solo `bulk_line_items`, pero **Clover capa a 100 items/request** (120 → HTTP 400, 0 creados) → **una mesa grande / catering (>100 items) fallaba por completo**. Fix: **chunking en lotes de ≤100** (`reconcile-items.ts`). **Verificado (E1): 120 enviados → 120 aterrizan; (E5): 105 items con modificadores en fronteras de chunk → correlación correcta**. Unit test `clover-inject.test.ts` (+1).
- Edge cases verificados: items idénticos duplicados con modificadores distintos (cada línea su modificador, E2), item precio 0 (E3), reconcile vacío (E4), caracteres especiales/acentos/comillas/HTML (E6 — round-trip OK).
- **[Limitación de Clover, documentada]** emoji / caracteres astrales (4-byte UTF-8) en nombres de línea → Clover los almacena como "?" (no es bug de MCM; se envía verbatim). BLOQUEOS.
- **NEW** scripts `N-edge-hunt.ts`, `O-edge-hunt2.ts`. Suite **149/6**, tsc limpio.
