# Slice D — Órdenes outbound (MCM → Clover)

**Estado:** VERIFICADO contra sandbox. Flujo preexistente de producción (`clover.create_order` + `clover.reconcile_items`). Harness: `docs/clover-bidi/scripts/D-outbound.ts`. Evidencia: `evidence/D-outbound.json`.

## Qué se verificó (handlers reales de producción)
Se condujeron los handlers `create_order` (adopt-or-create) + `reconcile_items` (DELETE+RECREATE + set total) contra el site A / sandbox:

| Prueba | Resultado (N=5) |
|---|---|
| Órdenes creadas en Clover | 5/5 |
| Con line items | 5/5 |
| **Total exacto al centavo** (Clover.total == Σ items) | **5/5** |
| **Idempotencia (adopt)** — dedup primario `clover_ticket_id` persistido | **adopted=true, same_clover_id=true** (retry NO duplica la orden Clover) |
| Cleanup | 5 órdenes Clover borradas |

La idempotencia se probó por el **path de producción**: una fila MCM `orders` real cuyo `clover_ticket_id` se persiste en el primer create; el retry lo lee (`getOrderCloverState`) y **adopta** la orden existente.

## Hallazgos (relevantes para producción — documentados, NO se tocó el edge)
1. **`externalReferenceId` (Invoice ID) máximo 12 caracteres** — un ref más largo → HTTP 400 `Invoice ID cannot exceed 12 characters`. El builder del edge (`buildCloverInjectionPayload`) debe respetar este cap (verificar que el ref derivado del `order.id` no exceda 12; los ids grandes deben acortarse, análogo al cap de 15 chars del ticket-name de Omnivore).
2. **`bulk_line_items` exige `price` explícito** — un line item solo con `{item:{id}}` → 400 `Price must not be null`. El edge ya congela line items con `name`+`price`+`unitQty` (correcto).
3. **Lookup secundario por `externalReferenceId`** (`findCloverOrderIdByExternalRef`) **no adoptó una orden recién creada** en sandbox (probable lag de indexado de búsqueda de Clover). El dedup **primario** (clover_ticket_id persistido) es el robusto y el que usa producción; el secundario es best-effort (ya envuelto en try/catch). → posible endurecimiento: reintentar el lookup / confiar en el primario (ya se hace).

## AC
- [x] create_order adopt-or-create round-trip.
- [x] reconcile total cent-exact (5/5).
- [x] Idempotencia adopt (primario) — sin duplicado.
- [ ] Supplemental post-pago: cubierto por unit tests (`clover-supplemental.test.ts`); no re-ejecutado live (evita crear pagos no-refundables en sandbox).
