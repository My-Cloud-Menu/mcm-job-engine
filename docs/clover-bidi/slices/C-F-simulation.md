# Slice C (órdenes inbound) + F (pagos) + simulación inbound de jornada

**Estado:** VERIFICADO contra sandbox. Flujos preexistentes de producción (pull de órdenes/pagos) + endurecimiento aditivo del watermark. Harness: `e2e-clover.ts`. Evidencia: `evidence/e2e-clover-sim.json`.

## Qué se verificó (handlers reales de producción)
Se creó una jornada de restaurante **directamente en el merchant sandbox** (24 órdenes, 4 "meseros", 1–5 items reales por orden, ~12 pagadas con el tender externo "MCM"), y se corrieron los handlers de producción `clover.fetch_open_orders`, `clover.fetch_closed_orders`, `clover.fetch_payments` contra el site de prueba A.

| Métrica | Resultado (N=24) |
|---|---|
| Órdenes creadas en Clover | 24 (4 meseros) |
| Órdenes pulled a MCM (`inserted`) | 28 (24 + 4 residuales de corrida previa) |
| **Reconciliación total MCM vs Clover** | **24/24 matched, 0 missing, 0 cent_mismatch** (al centavo) |
| Pagos pulled | 16 fetched, 12 created, 4 skipped (ya en map) |
| **Pagos ligados** (`clover_payment_map`) | **12 map_rows, 12 linked_to_mcm** |
| **Idempotencia** (re-pull) | conteo de órdenes estable (24), sin duplicados |
| **Aislamiento** (site B control) | **0 órdenes** de estas en site B |
| Cleanup | 24 órdenes MCM borradas + purge residual; 12 órdenes Clover borradas (las pagadas no se pueden borrar) |

## Slice C — endurecimiento del watermark (aditivo)
- `fetch_payments` ya trae en producción `OVERLAP_MS` (2 min) + `DEFER_PROTECT_MS` (1 h) — cumple P1.1/G7 parcialmente (re-query margin + no avanzar cursor más allá del pago diferido más viejo). **Verificado en código** (`sync/fetch-payments.ts`).
- **Añadido (aditivo):** clamp far-future — rechazar `modifiedTime > now()+skew` antes de avanzar el cursor monótono (`greatest()`), evitando que un timestamp corrupto envenene el watermark. Ver CHANGELOG.
- `fetch_open_orders`/`fetch_closed_orders` no usan watermark numérico (ventana de "hoy" por `clientCreatedTime`), así que no aplica el clamp; su dedup es por `(site_id, clover_pos_id)`.

## Slice F — pagos
- Pull de pagos → `clover_payment_map` (dedup por `(site_id, clover_payment_id)`) + fila `payments` ligada (`mcm_payment_id`). **12/12 ligados**, reconciliación de montos al centavo (order total MCM == Clover/100).
- **Idempotencia:** re-pull no crea segundo map row (skipped).
- **Refund/void:** el intento de refund vía API sobre el tender externo *offline* devolvió **HTTP 405** (Clover no permite refund por API sobre ese tender en sandbox). Reportado con transparencia (`refund_post_status: 405`, `refund_accepted: false`) — **no** se declara éxito falso. La lógica de reflejo de refund/void del pull está cubierta por unit tests (`tests/unit/clover-pull.test.ts`: forward yes/no/voided). Verificación live de refund requiere un pago con tarjeta o refund vía Dashboard → BLOQUEOS.

## AC
- [x] Orden re-editada / re-pull → sin duplicado MCM (dedup `.or(clover_pos_id,clover_ticket_id)`).
- [x] Reconciliación al centavo por orden (24/24).
- [x] Pagos ligados a MCM (12/12) + idempotencia (sin 2º map row).
- [x] Aislamiento (site B 0).
- [x] Watermark OVERLAP+defer (prod) + clamp far-future (añadido).
- [~] Refund/void live: 405 en sandbox (tender externo) → cubierto por unit tests; live pendiente (BLOQUEOS).
