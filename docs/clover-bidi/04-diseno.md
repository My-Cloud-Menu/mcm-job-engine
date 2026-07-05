# Fase 3 — Diseño aditivo implementado (Clover ↔ MCM bidireccional)

> El diseño de la extensión, tal como quedó en el working tree. **100% aditivo**: no altera firma
> ni contrato de código de producción (Omnivore / Clover previo). Multi-tenant (`site_id` + RLS),
> idempotente, dinero en centavos, **inbound solo por sync/polling (sin webhooks)**. Verificado
> contra el sandbox `7ES0TRRRYJCY1` en sites de prueba dedicados (A `99990001` ON / B `99990002`
> control sin Clover) en DEV `blbelbdvykpvbeqbjqom`.

---

## 1. Convención de mapeo: `additional_properties.cloverId`

Espeja exactamente el patrón Omnivore (`omnivoreId`). Toda fila MCM importada de Clover lleva su id
Clover en `additional_properties.cloverId` (los ids Clover son **per-merchant** → se repiten entre
sites, de ahí `UNIQUE(site_id, cloverId)` en los mapas). Match everywhere por `(site_id, cloverId)`;
toda lectura/escritura scopeada por `site_id`.

| Entidad Clover | Tabla MCM | Clave de match | Notas |
|---|---|---|---|
| category | `categories` | `additional_properties.cloverId` | `name`, `menu_order`=`sortOrder`, `status='published'` |
| item | `products` | `additional_properties.cloverId` | `price`=cents/100, `available` → `status`/`stock_status`, tax_class por nombre de rate |
| modifier | `ingredients` | `additional_properties.cloverId` | `price`, `cloverName` |
| modifier_group | `ingredients_groups` | `additional_properties.cloverId` | `ingredients=[{id}]`, `products_included` text[], `minimum/maximum` desde `minRequired/maxAllowed` |
| employee | `employees` | `(site_id, login = unhashedPin)` | `pos_id` = id Clover; rol conservador |

---

## 2. Job types nuevos + `sync_schedules` (flags default OFF)

Handlers nuevos en `src/handlers/clover/sync/`, todos registrados vía `registerHandler('clover', …)`
en la queue `pos_sync`, gateados por flag per-tenant (default OFF):

| Handler / `sync_type` | Flag (config) | Intervalo (config / default) | Qué hace |
|---|---|---|---|
| `clover.fetch_products` | `sync_products` | `cloverCatalogSyncIntervalSeconds` / **86400** | Orquesta categorías → productos → item_stock → modificadores (single `GET /items?expand=…`) |
| `clover.fetch_employees` | `sync_employees` | **86400** | Empleados por `(site_id, login=unhashedPin)`; PIN null → skip + evento |
| `clover.fetch_item_stock` | `sync_item_stock` | `cloverItemStockSyncIntervalSeconds` / **300** | 86 ligero (solo flip de `stock_status`/`status`), intervalo corto |

Flags reservados en el schema pero sin handler-scheduler dedicado esta noche: `sync_tables`
(mesas deferred), `sync_modifiers` (los modificadores se sincronizan dentro de `fetch_products`).
Master switch = `integration.active`. Rollout: activar solo en el site de prueba; los merchants
existentes quedan `disabled` por el backfill.

### Piezas de cada handler
- `getSiteIntegrationConfig(site_id,'clover','pos')` → `CloverConfigSchema.parse(config)`; si el flag ≠ true → `complete_sync_schedule` (si hay `schedule_id`) + `return { skipped_reason: … }` (**flag OFF ⇒ 0 trabajo**).
- `createCloverClient` + `fetchAllCloverElements` (paginado, rate-limited).
- Eventos PostHog (G14) + sync-log best-effort + `complete_sync_schedule` con cursor `null` (catálogo no usa watermark numérico).
- Errores vía `mapCloverError(err, 'CLOVER_FETCH_*_FAILED')`.

---

## 3. Migración 028 — extensión byte-for-byte + backfill + sync-log

`migrations/028_clover_catalog_schedules.sql`:

- **`ensure_sync_schedules`** (`CREATE OR REPLACE`) — la rama **omnivore se copia byte-for-byte de la mig 021**; solo se **anexan** filas Clover catálogo (`fetch_products`/`fetch_employees`/`fetch_item_stock`) con `status = case when <flag> then 'active' else 'disabled' end ::schedule_status` (cast crítico de mig 014). Flags leídos con `coalesce((config->>'sync_*')::boolean, false)`. Intervalos con `coalesce(nullif(…,'')::int, default)` + piso mínimo. El `ON CONFLICT … DO UPDATE` solo re-setea `interval_seconds` para los sync_types configurables.
- **`trigger_sync_now`** (`CREATE OR REPLACE`) — whitelist extendido con los 3 nuevos `sync_type` Clover; rama omnivore intacta.
- **Backfill** — `INSERT … status='disabled' … ON CONFLICT DO NOTHING` de las 3 filas catálogo para cada site Clover activo (para que `trigger_sync_now` siempre halle `schedule_id`; los tenants existentes quedan `disabled` ⇒ intactos).
- **Tablas sync-log** — `clover_inventory_sync_log` + `clover_employee_sync_log`: índice en `(site_id, created_at desc)`, `ENABLE ROW LEVEL SECURITY` **sin políticas** + `REVOKE ALL … FROM anon, authenticated` (⇒ **service_role only**, mirror migs 008+010).
- **Down** = re-aplicar el cuerpo previo de la mig 021 verbatim + `DROP TABLE` de los dos logs.

**Regresión G2 (obligatoria, PASÓ):** tras aplicar 028,
`ensure_sync_schedules(<omnivore_site>, 'omnivore', true)` → `action='synced'`, filas Omnivore
idénticas (`fetch_recent_orders` active/60 preservado; resto disabled/86400), sin cambio de
`status/interval_seconds/last_cursor`.

---

## 4. Empleados — `(site_id, login = unhashedPin)`, `pos_id = id Clover`

`fetch-employees.ts`:
- `login` = `unhashedPin` de Clover (el PIN). PIN vacío/null → `skipped_no_pin++` + evento `clover_employee_pin_unmatched` (**NO se descarta silenciosamente**).
- `pos_id` = id Clover (string); `first_name`/`last_name` por split de `name`; `check_name` = `nickname`.
- **Rol conservador:** `mapRole` — Clover ADMIN/MANAGER → MCM `manager` (nunca concede `admin` desde el POS); resto → `waiter`; **nunca degrada** un MCM `admin` existente.
- Upsert `onConflict: 'site_id,login'` en chunks de 500; nunca borra empleados (aditivo).

---

## 5. Modificadores → `ingredients` / `ingredients_groups`

`modifier-sync.ts` (llamado dentro de `fetch_products`, forma aprendida de filas Omnivore reales):
- `GET /modifier_groups?expand=modifiers`.
- Cada `modifier` → fila `ingredients` (`price` cents/100, `cloverId`, `cloverName`). Idempotente (precio comparado en **céntimos enteros**).
- Cada `modifier_group` → fila `ingredients_groups`: `ingredients = [{ id: <mcm ingredient id> }]`, `products_included` = ids MCM de productos que enlazan el grupo (desde `item.modifierGroups`), `minimum/maximum` desde `minRequired/maxAllowed` (0 si ausente).
- **Follow-up:** soft-archive de ingredients/groups ausentes (hoy solo create/update/skip — menor riesgo que productos).

---

## 6. Soft-archive (G9) — nunca DELETE

Endurecimiento sobre el edge (que hace hard-DELETE). En `catalog-sync.ts`:
`fetchAllCloverElements` devuelve `{ elements, complete }`. **Solo si `complete === true`** (sweep
completo, no página parcial/capada) las filas cuyo `cloverId` desapareció se marcan
`status='draft'` + `additional_properties.cloverArchived=true` (productos además
`stock_status='outofstock'`). En sweep incompleto **no se archiva nada**. `syncCloverItemStock`
nunca resucita un producto soft-archived vía stock.

---

## 7. Token-bucket per-site (G1) + watermark clamp (G7)

- **`rate-limit.ts`** — token-bucket in-process per-site delante de **todo** fetch de catálogo. `acquireCloverCatalogToken(siteId)` cede hasta tener token. Env: `CLOVER_CATALOG_QPS` (default 4), `CLOVER_CATALOG_BURST` (default 6). No toca el breaker compartido `clover:pos_sync` (evita que un burst de 429 del primer sweep abra el breaker y frene el pull de órdenes/pagos de producción). Los concurrency-limits `(queue,integration,site)` capan paralelismo, no rate → el bucket cubre el rate.
- **Watermark clamp** — `fetch-payments.ts` (edición aditiva, G7): antes de avanzar el cursor monótono (`greatest()`), se rechaza `modifiedTime > now()+skew` (`Math.min(advanced, now()+5min)`), evitando que un timestamp far-future del sandbox envenene el watermark. Defensivo; no altera el flujo normal. `fetch_open_orders`/`fetch_closed_orders` no usan watermark numérico (ventana "hoy" por `clientCreatedTime`) → dedup por `(site_id, clover_pos_id)`.

---

## 8. Región / base-URL (Slice A)

`region.ts` — `resolveCloverBaseUrl(config)`: **`config.apiUrl` gana verbatim** (comportamiento
idéntico al previo para todo config de producción) → si no, `config.region` mapea a host canónico
(`CLOVER_REGION_HOSTS`: us/na, eu, la/latam, sandbox/dev, apisandbox) → default `https://api.clover.com`.
`client.ts` delega el `baseURL` a esta función (firma sin cambios). `CloverConfigSchema` gana
`region` + flags de catálogo como `.optional()` (z.object no-strict → un config de producción
sigue haciendo `.parse()` sin error, G3).

---

## 9. Los 14 guardarrailes (G1–G14) — copiados del plan

> Reglas production-grade que aplican a TODO el trabajo. Violarlas rompe producción o corrompe datos.

- **G1 — Circuit breaker compartido `clover:pos_sync`.** Todos los sync corren en queue `pos_sync` y comparten UNA instancia de breaker. Un burst de 429 del primer sweep de catálogo abriría el breaker y frenaría el pull de órdenes/pagos de producción. Mitigación aditiva: *token-bucket per-site delante de los fetch de catálogo*. **NO** cambiar el keying del breaker ni el CHECK del queue `pos_sync` esta noche (requiere regresión Omnivore dedicada).
- **G2 — Funciones compartidas `ensure_sync_schedules` / `trigger_sync_now` sirven a Omnivore Y Clover.** Son `CREATE OR REPLACE`. Copiar la rama existente **byte-for-byte**, solo **anexar** filas Clover, con flags `coalesce((config->>'sync_*')::boolean,false)` (default OFF). Incluir **backfill** `INSERT … status='disabled' … ON CONFLICT DO NOTHING` para cada site Clover activo. Extender el whitelist de `trigger_sync_now`. **Regresión obligatoria:** `ensure_sync_schedules(<omnivore_site>,'omnivore',true)` → `action='synced'` y ningún row Omnivore cambia `status/interval_seconds/last_cursor`.
- **G3 — `CloverConfigSchema` (zod) está en el hot-path de injection.** Todo campo nuevo `.optional()` o `.default(false)`. **Nunca** `.strict()` ni required. Un config de producción existente debe seguir haciendo `.parse()` sin error.
- **G4 — DLQ + alert email disparan por `queue_name='pos_sync'`.** Los nuevos catalog jobs heredan DLQ y alertas. Poner `max_attempts` bajo en pasos de catálogo y documentar; aceptar (o silenciar por sync_type si el patrón existe). No floodear on-call en el primer sweep.
- **G5 — Race push↔pull en la misma orden (Slice E).** Antes de cualquier `reconcile_items`/`/modifications` sobre una orden: verificar en `clover_payment_map` que no tenga tender/pago aplicado; si lo tiene, **rehusar** y emitir `clover_reconcile_skipped_paid_order`. Serializar push y merge por orden (reusar patrón `serialize_sync_enqueue`, mig 017). El write-path de modificadores nativos es el de mayor blast-radius → **diferir** (mantener fallback de nota).
- **G6 — Paginación por cursor estable, no offset.** El offset de Clover está capado (~1000). `fetch_products/employees/item_stock/modifier_groups` paginan por `filter=id>lastId` (orden id) o `modifiedTime`. Invisible en sandbox (pocos items) → AC con >page-size sintético o cap forzado.
- **G7 — Watermark robusto (mirror `fetch-payments.ts`).** Copiar `OVERLAP_MS`(~2min) + `DEFER_PROTECT_MS`. `complete_sync_schedule` avanza con `greatest()` (monótono) → **clamp**: rechazar `modifiedTime > now()+skew` antes de que envenene el cursor.
- **G8 — Mapas de catálogo:** cada tabla nueva con `UNIQUE(site_id, cloverId)` + `ENABLE ROW LEVEL SECURITY` sin políticas + `REVOKE ALL … FROM anon, authenticated` + índice en `site_id` (mirror migs 008+010). Convención en catálogo existente: `additional_properties.cloverId` (espeja `omnivoreId`).
- **G9 — Solo soft-archive.** Nunca DELETE de catálogo MCM por ausencia en una página; marcar `available=false`/archivado, y **solo** tras un sweep completo y exitoso (nunca en página parcial/fallida).
- **G10 — Secret hygiene.** Todo cliente vía `createCloverClient` (headers centralizados) + logs por `sanitize`. AC: grep de logs por el token → 0 hits. Nunca imprimir `apiKey` en reportes/evidencia.
- **G11 — Feature flags default OFF.** Nombres snake_case: `sync_employees`, `sync_tables`, `sync_products`, `sync_modifiers`, `sync_item_stock`, `cloverCatalogSyncIntervalSeconds`. Master switch = `integration.active`. Rollout: activar solo en site de prueba; merchants existentes intactos (backfill los deja `disabled`).
- **G12 — Backfill vs incremental.** Dos modos por tipo: full-sweep único (acotado, cursor-paginado, archiva solo al completar) e incremental por `modifiedTime`. Guardar modo en `schedule.config`. El primer sweep va detrás del token-bucket (G1) + concurrencia baja.
- **G13 — Rate budget per-site.** Sumar QPS de todos los sync activos (open 60s + closed 300s + payments 30s + catálogo + item_stock) + push, y mantenerlo bajo el techo del token de Clover. Los concurrency-limits `(queue,integration,site)` capan paralelismo, **no** rate → el token-bucket (G1) es quien cubre el rate.
- **G14 — Observabilidad de dominio (PostHog).** Agregar: `clover_catalog_sync_completed {type,created,updated,archived,skipped}`, `clover_employee_pin_unmatched`, `clover_table_unmatched`, `clover_modifier_unmapped`, `clover_order_enrichment_incomplete`, `clover_watermark_advanced {sync_type,from,to}`, `clover_watermark_stuck {oldest_deferred_age_s}`, `clover_reconcile_skipped_paid_order`, `clover_double_charge_guard_hit`.

> Estado de implementación: G1, G3, G6 (cap+log), G7, G8, G9, G10, G11 implementados y verificados.
> G2 con regresión Omnivore PASADA. G14 parcialmente cableado (`clover_catalog_sync_completed`,
> `clover_employee_pin_unmatched` emitidos; el resto de eventos son señal futura de los slices
> deferred). G5 aplica al write-path deferido (fallback de nota intacto). G4/G12/G13 son reglas
> operativas honradas por diseño (intervalos altos por defecto, flags OFF, token-bucket).

---

## 10. Feature flags / rollout

1. Aplicar mig 028 (idempotente; ya en DEV). 2. En el site objetivo, setear en `site_integrations.config`
los flags `sync_products`/`sync_employees`/`sync_item_stock=true` + intervalos opcionales. 3. Re-correr
`ensure_sync_schedules(site,'clover',true)` (o guardar la integración en el dashboard) → activa los
schedules. 4. El scheduler (leader-elected) encola los jobs; el token-bucket + intervalos altos
limitan el primer sweep. Merchants existentes sin los flags → filas `disabled` ⇒ **0 jobs nuevos**.

---

## 11. Runbook de rollback

1. Flip todos los `sync_*` OFF → `ensure_sync_schedules` deja las filas `disabled` (0 jobs).
2. Re-aplicar el cuerpo previo de `ensure_sync_schedules`/`trigger_sync_now` (down-migration = cuerpo de la mig 021 verbatim + whitelist previo).
3. `DROP TABLE clover_inventory_sync_log, clover_employee_sync_log` (service-role only, nada más los lee).
4. Registrar en `CHANGELOG-nocturno.md`.

Ningún paso toca Omnivore ni el Clover de producción (order push/pull, payment inject/pull,
supplemental, tax push) — todos son caminos independientes gateados por sus propios flags.

---

## 12. Contrato POS / Order&Pay — sin cambios

`app/pos-order` y O&P renderizan desde columnas canónicas de `orders`/`line_items`/catálogo; la
tarjeta de live-orders ya lee `clover_pos_id || clover_ticket_id`. Importar catálogo Clover a
`products`/`categories`/`ingredients` (keyed por `cloverId`) es transparente. **CERO cambios en POS
u O&P.**

---

## 13. Aislamiento multi-tenant (1 solo merchant sandbox)

- **Row/control-plane (verificado):** site A (Clover ON) escribe catálogo/órdenes/pagos scopeados por `site_id`; site B (sin Clover, flags OFF) → **0 categorías/productos/ingredients/groups/órdenes**. Toda escritura lleva su filtro `site_id`; idempotency keys namespacean `site_id`; RLS service-role-only en los mapas/logs nuevos.
- **Credential-scoping (parcial):** un site de control con `merchantId` inválido falla 401/404 → prueba la resolución de credenciales per-site desde `site_integrations`.
- **Limitación (→ BLOQUEOS):** con 1 solo merchant no se prueba que el token de un merchant no lea datos de otro en la capa API de Clover. Follow-up: 2º merchant sandbox.

---

## 14. Archivos entregados (aditivo)

- **NEW** `src/handlers/clover/region.ts`; `src/handlers/clover/sync/{rate-limit,catalog-sync,modifier-sync,fetch-products,fetch-employees,fetch-item-stock}.ts`.
- **EDIT aditivo** `src/handlers/clover/client.ts` (`resolveCloverBaseUrl` + `CloverConfigSchema` flags `.optional()`); `load-handlers` (3 imports); `src/handlers/clover/sync/fetch-payments.ts` (clamp far-future, G7).
- **NEW migración** `migrations/028_clover_catalog_schedules.sql` (aplicada a DEV).
- **NEW tests** `tests/unit/clover-region.test.ts` (7), `tests/unit/clover-catalog-sync.test.ts` (9).
- **NEW harness** `e2e-clover.ts` + `docs/clover-bidi/scripts/{00-smoke,B-probe,B-run.ts,B-toggle,D-outbound.ts,E-modifications-spike}.cjs`.
- **DEV data (MCP):** sites A `99990001` / B `99990002` + integración Clover de A (clon del row del merchant sandbox).
- **POS / O&P: sin cambios.**
