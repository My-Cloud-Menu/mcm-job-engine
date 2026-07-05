# Reporte final — Clover ↔ MCM bidireccional (corrida nocturna 2026-07-02)

> **Modo:** autónomo, aditivo puro, cero commits (todo en working tree de `audit/delivery-overnight`).
> **Entorno:** DEV Supabase `blbelbdvykpvbeqbjqom` + Clover sandbox (`sandbox.dev.clover.com`, merchant `7ES0TRRRYJCY1` "MCM Restaurant Test"). Prod **NO** tocada.

## 1. Resumen ejecutivo (solo aditivo)

Se cerró el gap de paridad de Clover contra Omnivore con **código 100% aditivo** sobre el Job Engine, verificado end-to-end contra el sandbox:

- **Slice A — Fundaciones:** resolver de región/base-URL aditivo (`region.ts`), `CloverConfigSchema` con flags `.optional()`; tender externo "MCM" verificado; OAuth diferido (documentado).
- **Slice B — Catálogo inbound (NUEVO, el gran gap):** sync Clover→MCM de **categorías, productos, item_stock/86, modificadores, empleados** por `additional_properties.cloverId`, con soft-archive (nunca DELETE), token-bucket, paginación cap+log, gate por flags default OFF. Migración `028` extiende `ensure_sync_schedules`/`trigger_sync_now` (rama omnivore intacta) + sync-log tables con RLS.
- **Slice C — Órdenes inbound:** pull open/closed endurecido; clamp far-future del watermark (aditivo).
- **Slice D — Órdenes outbound:** create+reconcile verificado (cent-exact + idempotencia adopt).
- **Slice F — Pagos:** pull + `clover_payment_map` + reconciliación al centavo + idempotencia.
- **Slice E — Modificación bidi:** cubierta por reconcile-out + poll-in + guard de orden pagada; modificadores nativos spike-verificados (feasible, no-idempotentes) → **deferred** (fallback de nota intacto). Mesas: no factibles (órdenes sin table) → deferred.

**POS y Order&Pay: CERO cambios** — ya son provider-agnósticos y renderizan Clover idéntico a Omnivore.

## 2. Matriz de paridad (tras la corrida)

| Capacidad | Omnivore | Clover — antes | Clover — ahora |
|---|---|---|---|
| Órdenes inbound (poll) | ✅ | ✅ | ✅ verificado (24/24 cent-exact) |
| Órdenes outbound (create+reconcile) | ✅ | ✅ | ✅ verificado (5/5 cent-exact + adopt) |
| Modificación bidi | ✅ (managed) | reconcile+pull | ✅ reconcile+pull+supplemental guard |
| Pagos (push+pull+voids/refunds) | ✅ | ✅ | ✅ verificado (12/12 ligados) |
| Sync items | ✅ | manual | ✅ **NUEVO** programado (114) |
| Sync categorías | ✅ | manual | ✅ **NUEVO** programado (20) |
| Sync modificadores | ✅ | ❌ (nota) | ✅ **NUEVO** (90 ings/10 groups) |
| Sync empleados | ✅ | ❌ | ✅ **NUEVO** (handler; sandbox sin PIN) |
| 86 / out-of-stock | ✅ | parcial | ✅ **NUEVO** programado (round-trip) |
| Sync mesas | ✅ | ❌ | ⚠️ deferred (órdenes Clover sin table) |
| Región/base-URL | n/a | solo US | ✅ **NUEVO** resolver US/EU/LA/sandbox |
| Modificadores nativos outbound | ✅ | nota | ⚠️ deferred (feasible, requiere idempotencia — P1.6) |
| OAuth expiring tokens | n/a | estático | ⚠️ deferred (untestable sin app OAuth) |

## 3. Resultados de la simulación (jornada inbound, N=24)

- 24 órdenes / 4 meseros / items reales variados; **24/24 pulled a MCM, reconciliación al centavo (0 mismatch)**.
- 12 pagos → **12 `clover_payment_map` rows, 12 ligados a MCM** (`mcm_payment_id`).
- **Idempotencia:** re-pull → conteo estable, sin duplicados. Outbound retry → adopt (sin duplicar orden Clover).
- **Aislamiento:** site de control B (99990002) = **0 órdenes / 0 catálogo** de estas operaciones (toda query scopeada por `site_id`).
- Evidencia: `evidence/e2e-clover-sim.json`, `evidence/D-outbound.json`, `evidence/B-probe.json`, `evidence/00-smoke.json`, `evidence/E-modifications-spike.json`.

## 4. Reconciliación al centavo

- Inbound: `MCM order.total*100 == Clover order.total (cents)` en 24/24 órdenes.
- Outbound: `Clover order.total == Σ(line item prices)` en 5/5.
- Pagos: monto/orden ligado 1:1 vía `clover_payment_map` (dedup `(site_id, clover_payment_id)`).
- **Concurrencia (P2.7):** 4 pulls en paralelo → 1 fila MCM por orden (índice único `orders_site_clover_pos_id_uniq` + ON CONFLICT). Update de orden → actualiza en sitio, sin duplicar. Evidencia `evidence/G-edgecases.json`.
- **Anti-duplicación exhaustiva (`ALL_DEDUP_OK: true`, `slices/H-dedup.md`):** S1 outbound→inbound (WS-6/F12) → 1 fila (misma orden, no duplica lo que MCM empujó); S2 8 pulls paralelos → 1 c/u; S3 6 pulls repetidos → siempre 1; S4 4 fetch_payments paralelos → 1 map row/pago. Respaldado por índices únicos + lookup dual-id.

## 5. Cero regresión

- `npx tsc --noEmit`: **limpio**.
- Suite: **139 passed / 6 failed**. Las 6 fallas son **pre-existentes en la rama** (Omnivore/circuit-breaker, mocks) — idénticas al baseline pre-corrida; **cero fallas nuevas**. +16 tests Clover nuevos (region 7 + catalog-sync 9) verdes.
- Regresión G2: `ensure_sync_schedules(<omnivore>,'omnivore',true)` deja las filas omnivore idénticas.
- Ningún archivo de producción con firma/contrato alterado. Ediciones a código existente (documentadas): `client.ts` (baseURL delega a resolver, retro-compatible + flags opcionales), `fetch-payments.ts` (clamp far-future defensivo), `load-handlers.ts` (3 imports). El edge de producción NO se tocó.

## 6. Despliegue (detrás de feature flags) + rollback

**Activación por tenant (default OFF):** en `site_integrations.config` (provider=clover), setear `sync_products`/`sync_employees`/`sync_item_stock` = true, y para que el catálogo aparezca en el POS `autoManageCloverCatalog = true` (crea el catálogo "Clover (auto)"; canales opcionales `cloverCatalogChannels`, default `['pos']`), luego `select ensure_sync_schedules(<site_id>,'clover',true)`. Intervalos opcionales `cloverCatalogSyncIntervalSeconds` / `cloverItemStockSyncIntervalSeconds`.

**Para operación real:** el worker `pos_sync` del Job Engine debe redeployarse (imagen Docker) para cargar los nuevos handlers (`WORKER_INTEGRATIONS` ya incluye `clover`). Aplicar migraciones `028` (schedules) y `029` (índices únicos `(site_id,cloverId)` — usar `CONCURRENTLY` en prod). DEV ya aplicadas; prod pendiente. Ningún edge function nuevo/modificado.

**Compatibilidad /pos-order + robustez (ver `slices/I-pos-compat.md`, `slices/robustness-fixes.md`):** el catálogo sincronizado ahora aparece en el menú del POS (`get-menus` → 104/114 productos, 10 sin categoría por diseño); las órdenes traídas renderizan modificadores (`attributes`) y resuelven `product_id` al producto MCM. Robustez: soft-archive con floor-guard (no borra catálogo vivo), detección de cambios completa (is_taxable/sku/description), y **catálogo concurrency-safe** (índices únicos + insertOrAdopt: 2 syncs concurrentes → 0 duplicados, verificado).

**Rollback:** (1) flags `sync_*` → OFF (⇒ `ensure_sync_schedules` deja los schedules `disabled`). (2) Re-aplicar el cuerpo previo de `ensure_sync_schedules`/`trigger_sync_now` (migración 021 verbatim). (3) `DROP TABLE clover_inventory_sync_log, clover_employee_sync_log` (service-role only). Los mapeos `additional_properties.cloverId` en catálogo son inertes si el sync se desactiva.

## 7. Pendientes / preguntas para Carlos (detalle en `BLOQUEOS.md`)

- **Empleados por PIN:** el sandbox no expone `unhashedPin` → verificación live del match `(site_id,login)` pendiente de un merchant con passcode-login.
- **Modificadores nativos outbound** (`/modifications`): feasible + no-idempotente (verificado). Cablearlo requiere idempotencia MCM-side + guard G5 + tocar el edge → follow-up con su ciclo de pruebas. Hoy queda el fallback de nota.
- **Mesas Clover:** las órdenes core no traen `table` → sync de mesas solo tendría sentido floor-layout-only (Clover Tables app aparte). Confirmar si se requiere.
- **OAuth expiring tokens:** requiere una app OAuth de Clover registrada para testear el intercambio (sandbox usa token estático).
- **externalReferenceId cap 12 chars:** verificar que el builder del edge lo respeta para ids grandes.
- **Refund/void live:** requiere pago con tarjeta o Dashboard (tender externo offline → 405).
- **2º merchant sandbox:** no disponible → aislamiento cross-merchant a nivel API queda como limitación documentada (se probó aislamiento row/control-plane con 2 sites).

## 8. Artefactos

- Código nuevo: `src/handlers/clover/{region.ts, sync/{rate-limit,catalog-sync,modifier-sync,fetch-products,fetch-employees,fetch-item-stock}.ts}`; migración `028`; tests `clover-region.test.ts`, `clover-catalog-sync.test.ts`.
- Scripts/harness: `docs/clover-bidi/scripts/*` + `e2e-clover.ts` (root).
- Docs: `docs/clover-bidi/{00..04,99, CHANGELOG-nocturno, BLOQUEOS}.md` + `slices/*` + `evidence/*`.
- Sites de prueba DEV: A `99990001` (Clover ON), B `99990002` (control, sin Clover).
