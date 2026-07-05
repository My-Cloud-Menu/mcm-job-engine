# Slice B — Catálogo inbound (Clover → MCM)

**Estado:** COMPLETO (categorías, productos, item_stock/86, modificadores, empleados) · aditivo puro · source of truth = Clover (decisión #2).

## Implementado (todo NEW en `src/handlers/clover/sync/`)
- `rate-limit.ts` — token-bucket per-site (G1/G13) delante de los fetch de catálogo (no toca el breaker compartido `clover:pos_sync`).
- `catalog-sync.ts` — `fetchAllCloverElements` (paginado + cap+log, G6), `syncCloverCategories`, `syncCloverProducts`, `syncCloverItemStock`. Match por `additional_properties.cloverId`; **soft-archive** (status=draft + `cloverArchived`, G9 — mejora sobre el DELETE del edge).
- `modifier-sync.ts` — `syncCloverModifiers`: modifier_groups/modifiers → `ingredients_groups`/`ingredients` (cloverId), `ingredients=[{id}]`, `products_included` desde `item.modifierGroups`. Forma aprendida de filas Omnivore reales.
- `fetch-products.ts` (handler `clover.fetch_products`) — orquesta categorías→productos→item_stock→modificadores. Gate `config.sync_products` (default OFF). Eventos PostHog (G14), sync-log best-effort.
- `fetch-employees.ts` (handler `clover.fetch_employees`) — match `(site_id, login=unhashedPin)`, `pos_id`=id Clover, rol sin degradar admin. PIN null → skip + evento `clover_employee_pin_unmatched`.
- `fetch-item-stock.ts` (handler `clover.fetch_item_stock`) — 86 ligero (intervalo minutos).
- **EDIT aditivo** `load-handlers.ts` (3 imports), `client.ts` (`CloverConfigSchema` flags `.optional()`).
- **NEW migración `028_clover_catalog_schedules.sql`** — extiende `ensure_sync_schedules`/`trigger_sync_now` (rama omnivore **byte-for-byte**, solo anexa filas clover, flags default OFF) + backfill `disabled` + tablas `clover_inventory_sync_log`/`clover_employee_sync_log` (RLS, revoke anon/authenticated). Aplicada a DEV.

## Verificado contra sandbox (site 99990001, merchant 7ES0TRRRYJCY1)
| Prueba | Resultado |
|---|---|
| Sync inicial | 20 categorías + 114 productos + 90 ingredients + 10 groups **created** |
| Idempotencia (re-run) | 0 created / 0 updated / todo skipped (tras fix de precio en céntimos) |
| 86 / out-of-stock | `available=false` → producto draft/outofstock; `available=true` → instock (round-trip) |
| Soft-archive (G9) | producto con cloverId inexistente → **draft + cloverArchived=true, NO borrado** (114 reales intactos) |
| Modifier linkage | `products_included` poblado (Egg→9 prods, Espresso→18, Crepes→30 ings) |
| **Aislamiento (site B 99990002)** | **0 categorías, 0 productos, 0 ingredients, 0 groups** — toda escritura scopeada por `site_id` |
| Empleados | total 1 / created 0 / skipped_no_pin 1 (sandbox sin PIN — handler correcto, verificación live parcial) |

## Regresión G2 (funciones compartidas)
Tras aplicar 028: `ensure_sync_schedules(48372619,'omnivore',true)` → filas omnivore **idénticas** (fetch_recent_orders active/25 preservado; resto disabled/86400). Rama omnivore intacta.

## Tests
- `tests/unit/clover-catalog-sync.test.ts` (9) — paginación+cap, idempotencia (precio céntimos), soft-archive complete-vs-incomplete, 86.
- `tests/unit/clover-region.test.ts` (7).
- Suite completa: **139 passed / 6 failed** (las 6 pre-existentes de Omnivore; cero nuevas). `tsc --noEmit` limpio.

## Follow-ups (BLOQUEOS)
- Empleados: sandbox sin `unhashedPin` → link por PIN 0. Verificación live pendiente de un merchant con PIN visible.
- Modificadores: archive (soft) de ingredients/groups ausentes = follow-up (hoy create/update/skip). `minimum/maximum` desde `minRequired/maxAllowed` (0 si ausente).
- Paginación >6000 elementos (offset cap): follow-up cursor por `modifiedTime` (sandbox 114 < cap; se loguea si se alcanza).
- `fetch_tables`: **spike P1.5 = las órdenes Clover NO traen `table` ni `employee`** → order-enrichment de mesa no factible; tables queda floor-layout-only/deferred.
