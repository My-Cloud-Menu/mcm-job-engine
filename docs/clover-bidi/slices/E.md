# Slice E — Modificación bidireccional + modificadores nativos + spike de mesas

**Estado:** parcialmente cubierto por flujos existentes + spikes verificados; el write-path de modificadores nativos queda **feasibility-verified pero NO cableado** (decisión de riesgo).

## Modificación bidireccional de órdenes (cubierto)
- **MCM → Clover:** `reconcile_items` (DELETE+RECREATE + set total) — verificado en Slice D (5/5 cent-exact). Editar una orden = re-inyectar con nuevo `line_items_hash`.
- **Clover → MCM:** el pull recurrente (`fetch_open_orders`) re-lee la orden y `upsertOrdersFromClover` la actualiza (dedup por `(site_id, clover_pos_id)`) — verificado en la simulación (Slice C).
- **Guard de orden pagada (G5):** `reconcile_items` detecta `payments` en la orden Clover y NO la muta — ruta a **supplemental order** (`handlePaidPrimaryDelta`). Cubierto por unit tests `clover-supplemental.test.ts`. Previene el race push↔pull sobre órdenes pagadas.
- Clover no usa el modelo "managed order" síncrono de Omnivore O&P; su bidireccionalidad es reconcile-out + poll-in, ya probada.

## Modificadores nativos `/modifications` (spike — `evidence/E-modifications-spike.json`)
- **FEASIBLE:** `POST /orders/{id}/line_items` (item ref, single) → 200; `POST .../line_items/{liId}/modifications {modifier:{id},name,amount}` → 200; se leen vía `expand=lineItems.modifications`.
- **⚠️ Clover NO dedupea** (doble-POST del mismo modifier → **2** modificaciones) → **P1.6 CONFIRMADO**: un retry duplicaría el cargo del modificador.
- **Requisito para cablear (follow-up):** idempotencia MCM-side — leer `lineItems.modifications` existentes y dedup por `(line_item_id, modifier_id)` antes de cada POST; + el guard G5 (rehusar en órdenes con tender aplicado); + integrar en el builder de line items del edge (código de producción).
- **Decisión de esta noche:** NO se cablea al path de producción (mayor blast-radius; toca el edge). Se mantiene el **fallback de nota** existente (producción intacta). Queda especificado + de-risked para un follow-up con su propio ciclo de pruebas.

## Mesas (spike P1.5 — RESUELTO)
- Las órdenes core de Clover **NO traen `table` ni `employee`** (verificado con `/orders?expand=...`). El order-enrichment de mesa no es factible desde el Orders API (Clover Tables vive en la app "Tables" aparte).
- `fetch_tables` queda **floor-layout-only / deferred**, documentado. No se implementó para evitar una feature sin fuente de datos verificable.

## AC
- [x] Editar orden MCM→Clover (reconcile) y Clover→MCM (pull) — verificado.
- [x] Guard de orden pagada (supplemental) — unit tests.
- [x] Spike `/modifications`: feasibility + no-dedup (P1.6) verificados con evidencia.
- [ ] Wiring de modificadores nativos: **deferred** (requiere idempotencia + edge). Fallback de nota intacto.
- [x] Spike de mesas: resuelto (no factible → deferred).
