# Fase 2 — Gap analysis: paridad Omnivore ↔ Clover

> Matriz de paridad con la columna de **estado tras esta corrida** (2026-07-02). Distingue lo
> **VERIFICADO en sandbox** (request/response reales) de lo cubierto solo por **unit tests** y de lo
> **deferred**. Endpoint por fila. Nada inventado; los `⚠️` marcan lo no verificable esta noche.

Leyenda de estado: **✅ sandbox** = verificado con tráfico real · **🧪 unit** = cubierto por tests
con mocks · **⏸ deferred** = feasible pero no cableado/no testeable esta noche · **🔒 prod** = ya
existía en producción, verificado (no re-endurecido).

---

## Matriz principal

| Capacidad | Omnivore | Clover ANTES | Clover AHORA / verificado | Endpoint | Gap restante |
|---|---|---|---|---|---|
| **Órdenes inbound** | poll `fetch_recent_orders` | poll open/closed 🔒 | ✅ sandbox: 24/24 reconciliadas al centavo; dedup `.or(clover_pos_id,clover_ticket_id)`; watermark clamp far-future añadido (G7) | `GET /orders?filter=modifiedTime` | ninguno (hardening cerrado) |
| **Órdenes outbound** | 3 pasos | 2 pasos (create+reconcile) 🔒 | ✅ sandbox: 5/5 creadas, total cent-exact, adopt idempotente por `clover_ticket_id` | `POST /orders`, `/bulk_line_items`, `POST /orders/:id {total}` | ref ≤12 chars y `price` requerido documentados (edge no tocado) |
| **Modificación bidireccional** | merge por item_id (managed) | reconcile-out + poll-in 🔒 | ✅ reconcile-out (Slice D) + poll-in (Slice C); 🧪 guard orden pagada → supplemental | `bulk_line_items` + pull | Clover no usa managed-order síncrono; ver "modificadores nativos" |
| **Pagos** | inject + pull 🔒 | inject + pull (voids/refunds/tips) 🔒 | ✅ sandbox: 12/12 ligados en `clover_payment_map`, idempotente (sin 2º map row), cent-parity; 🧪 refund/void forward | `POST /orders/{id}/payments`, `GET /payments` | ⚠️ refund/void **live**: 405 en tender externo offline (BLOQUEOS) |
| **Items / productos** | sync ✅ | manual, sin scheduler | ✅ sandbox: 114 items keyed por `cloverId`, idempotente (precio en céntimos), **soft-archive** (G9), cursor cap+log (G6) | `GET /items?expand=…` | cursor por `modifiedTime` para >6000 (follow-up) |
| **Categorías** | sync ✅ | manual, sin scheduler | ✅ sandbox: 20 categorías keyed por `cloverId`, soft-archive | `GET /categories` | ninguno relevante |
| **Modificadores** | sync ✅ | ❌ (solo nota MCM→Clover) | ✅ sandbox: 10 groups + 90 ingredients → `ingredients_groups`/`ingredients`; `products_included` poblado | `GET /modifier_groups?expand=modifiers` | soft-archive de ingredients/groups ausentes = follow-up; `min/max` desde `minRequired/maxAllowed` |
| **Empleados** | `(site,login=PIN)` | ❌ | 🧪 handler `(site_id, login=unhashedPin)`, `pos_id`=id Clover, rol conservador; sandbox `unhashedPin=null` → skip + evento | `GET /employees` | ⚠️ match por PIN **live** pendiente (merchant sin PIN visible) |
| **Mesas** | floor_elements + RPC | ❌ | ⏸ **deferred**: spike P1.5 → órdenes Clover NO traen `table`; `fetch_tables` floor-layout-only | (Orders API no expone mesa) | Clover Tables vive en app aparte; enrichment no factible |
| **86 / out-of-stock** | ✅ | parcial, sin scheduler | ✅ sandbox: `available` → `stock_status` round-trip; handler `fetch_item_stock` intervalo corto (min) | `GET /items?expand=itemStock` | ninguno relevante |
| **Región / base URL** | n/a | solo `api.clover.com` | ✅ `resolveCloverBaseUrl` (apiUrl gana → region → default); 7/7 unit tests; US/EU/LA/sandbox | (config) | ninguno |
| **OAuth expiring** | n/a | token estático | ⏸ **deferred**: diseño + scaffold; intercambio live no testeable sin app OAuth | `POST /oauth/token` v2 | ⚠️ verificación live imposible en sandbox estático |

---

## Detalle por columna de evidencia

### ✅ Verificado en sandbox (tráfico real, con evidencia en `evidence/`)
- **Órdenes inbound + pagos** — jornada de 24 órdenes / 4 meseros / ~12 pagadas; `e2e-clover.ts`; 24/24 al centavo, 12/12 ligados, aislamiento site B = 0, cleanup. (`evidence/e2e-clover-sim.json`)
- **Órdenes outbound** — 5/5 create + reconcile, total cent-exact, adopt idempotente. (`evidence/D-outbound.json`)
- **Catálogo** — 20 cat / 114 prod / 90 ing / 10 groups; idempotencia; soft-archive; 86 round-trip; aislamiento site B = 0. (`evidence/B-probe.json`)
- **Región** — 7/7 unit tests + smoke merchant 200.
- **Spike `/modifications`** — feasible pero no-dedup (P1.6). (`evidence/E-modifications-spike.json`)

### 🧪 Cubierto por unit tests (no live esta noche)
- **Empleados** — `clover-catalog-sync.test.ts`; live por PIN bloqueado por sandbox sin `unhashedPin`.
- **Guard orden pagada → supplemental** — `clover-supplemental.test.ts` (12).
- **Refund/void forward** — `clover-pull.test.ts` (forward sí/no/voided); live = 405.
- **Región** — `clover-region.test.ts` (7); catálogo `clover-catalog-sync.test.ts` (9).
- Suite completa: **139 passed / 6 failed** (las 6 fallas son **pre-existentes de Omnivore**, ajenas a Clover; cero nuevas). `tsc --noEmit` limpio.

### ⏸ Deferred (documentado, con razón)
- **Modificadores nativos `/modifications`** — feasible pero Clover no dedupea (P1.6) → requiere idempotencia MCM-side `(line_item_id, modifier_id)` + guard G5 + tocar el edge. Fallback de nota intacto.
- **`fetch_tables` / mesa** — órdenes Clover sin `table`/`employee` (P1.5) → floor-layout-only.
- **OAuth expiring** — sandbox usa token estático; intercambio live no testeable sin app OAuth.
- **Aislamiento cross-merchant a nivel API** — 1 solo merchant sandbox → se cubre row/control-plane (site A ON vs site B sin Clover + prueba negativa con credencial inválida). Follow-up: 2º merchant.
- **Tax-pull hardcoded PR → tenant-aware** — solo si 100% aditivo; documentado, no arriesgado.
