# Hardening anti-duplicación de órdenes (exhaustivo)

**Estado:** `ALL_DEDUP_OK: true` contra sandbox. Harness `docs/clover-bidi/scripts/H-dedup.ts`, evidencia `evidence/H-dedup.json`. Foco: **garantizar que las órdenes Clover NUNCA se duplican en MCM** en ningún vector.

## Vectores probados

| # | Escenario | Riesgo | Resultado |
|---|---|---|---|
| **S1** | **outbound→inbound (WS-6/F12)**: MCM crea orden → `create_order` persiste `clover_ticket_id` → `reconcile_items` → `fetch_open_orders` | Que el pull inserte un DUPLICADO de la orden que MCM mismo empujó | **1 sola fila** — el pull la halla por `clover_ticket_id` (`.or(clover_pos_id,clover_ticket_id)`) y **actualiza la misma fila** (`same_row_id=true`, setea `clover_pos_id`). Sin duplicado. |
| **S2** | **Concurrencia**: 5 órdenes, **8 `fetch_open_orders` en paralelo** | Race check-then-insert → duplicados | **1 fila por orden** — el `.upsert(onConflict:'site_id,clover_pos_id', ignoreDuplicates:true)` sobre el índice único `orders_site_clover_pos_id_uniq` dedupea los inserts concurrentes. |
| **S3** | **Pulls repetidos** (6× secuenciales) | Acumulación de duplicados en el tiempo | Conteo **siempre 1** tras cada pull. |
| **S4** | **Concurrencia de pagos**: 3 pagos, **4 `fetch_payments` en paralelo** | Duplicar filas en `clover_payment_map` | **1 map row por pago** — dedup por UNIQUE `(site_id, clover_payment_id)`. |

## Garantías de esquema que lo respaldan
- `orders_site_clover_pos_id_uniq` — UNIQUE `(site_id, clover_pos_id)` (verificado en DEV). Habilita el `ON CONFLICT ... ignoreDuplicates` del pull.
- `clover_payment_map` — UNIQUE `(site_id, clover_payment_id)`.
- `payments` — UNIQUE `(site_id, pos_id)`.
- Lookup inbound `.or(clover_pos_id.eq.X, clover_ticket_id.eq.X)` — unifica la identidad de una orden que existe primero como push (clover_ticket_id) y luego se ve en el pull (clover_pos_id) → nunca crea una segunda fila (WS-6/F12).

## Multi-tenant
Todo el conteo/escritura scopeado por `site_id`; site de control B (99990002) permanece en **0 órdenes** en cada escenario.

**Conclusión:** la implementación es robusta contra duplicación de órdenes en las 4 rutas (outbound→inbound, concurrencia de pulls, pulls repetidos, concurrencia de pagos), respaldada por índices únicos + lookup dual-id + upsert idempotente.
