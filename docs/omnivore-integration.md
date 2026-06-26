# Omnivore POS integration — migration to `mcm-job-engine`

> Migra los 3 flujos Omnivore (inyección de orden, inyección de pago, sync) desde
> `mcm-edge-functions` (inline, sin reintentos) al motor de jobs, **sin cambiar
> un byte de lo que Omnivore recibe**. Arquitectura **Opción A**: la edge
> construye los payloads (reusando `omnivore-helper` tal cual) y el job-engine
> solo los **entrega** con retry/backoff/DLQ/idempotencia/resume.

## 1. Arquitectura (Opción A — "edge arma, job-engine envía")

```
EDGE (Deno)                                 JOB-ENGINE (Node)
─────────────────────────────────────────  ────────────────────────────────────
buildOmnivoreInjectionBody(order)           handlers/omnivore/inject/
  → { ticket, items, payments }               create_order  → POST /tickets
enqueueOmnivoreInjection(order)               add_items     → POST /tickets/:id/items
  → enqueue_job(pos_injection, 3 steps)       create_payment→ POST /tickets/:id/payments
                                             (each step idempotent + resumable)

buildOmnivorePaymentBody(payment)           handlers/omnivore/inject/
enqueueOmnivorePaymentInjection(payment)      payment_injection → POST /tickets/:id/payments
  → enqueue_job(pos_injection, 1 step)

sync_schedules (omnivore/fetch_recent_orders) handlers/omnivore/sync/
  ← ensure_sync_schedules RPC (dashboard)      fetch_recent_orders → fetch today + upsert
```

La construcción del payload **no se reescribió**; vive en
`mcm-edge-functions/.../omnivore-helper.ts`. El job-engine recibe los cuerpos ya
armados y congelados en `integration_jobs.payload`. Esto hace la divergencia
byte-a-byte **estructuralmente imposible**.

## 2. Inyección de orden (3 pasos)

**Payload del job** (`integration_jobs.payload`):
```jsonc
{
  "order_id": 12345,
  "ticket":   { "employee": "...", "order_type": "...", "revenue_center": "...",
                "name": "MCM 12345", "auto_send": true, "auto_close": true,
                "user_info": { "first_name": "...", "phone": "..." } },
  "items":    [ /* meta-items + product items con menu_item, price_level,
                   price_per_unit?, comment, modifiers=omnivoreParams, item_order_mode */ ],
  "payments": [ { "type": "3rd_party", "tender_type": "...", "tip": 0, "amount": <centavos> } ]
}
```
Es exactamente el cuerpo "All In One" legacy, **partido**: `ticket` = todo menos
`items` y `payments` (que por defecto son `[]` en Omnivore). Los bytes por campo
son idénticos; solo cambian los límites de request.

**Steps** (`job_steps`), idempotency_key estable por step:
| step | endpoint | idempotencia (header-independiente) |
|---|---|---|
| `create_order` | `POST /tickets` | adopta ticket abierto por **nombre** (`MCM {order_id}`) antes de crear; persiste `orders.omnivore_pos_id` al instante |
| `add_items` | `POST /tickets/:id/items` (batch `{items}`) | salta si el ticket **ya tiene items** |
| `create_payment` | `POST /tickets/:id/payments` | salta si `totals.due == 0` o ya hay pagos |

- Se envía el header **`Idempotency-Id`** (¡`-Id`, no `-Key`!) con el
  `step.idempotency_key`. Solo lo honran POS que lo soportan nativamente, por eso
  cada step lleva además su guard propio (lista arriba).
- El `name` no es único por orden en el site `414341196` (`MCM-{firstName}`); ahí
  se omite el guard por nombre y se confía en `Idempotency-Id`.

> **⚠️ Aloha: el header `Idempotency-Id` está MUERTO (probado en vivo 2026-06-13).**
> En Aloha (`pos_type=aloha`) el header se ignora en silencio y `eq(name)` da `bad_query`
> → `findOpenTicketIdByName` no funciona. Por eso `create_order` añade un fallback:
> en un **reintento** (`step.attempt_count > 0`) usa `findOpenTicketIdByNameScan`
> (lista tickets abiertos y matchea el nombre `MCM {order_id}` en memoria) para adoptar
> el ticket de un intento previo en vez de crear un duplicado. `add_items` (`getTicketItemCount`)
> y `create_payment` (`due==0`) ya eran seguros en Aloha. Detalle completo + el flujo síncrono
> de mesa (open-table/open-tab/fire/void) en
> `mcm-edge-functions/_docs/omnivore-idempotency-hardening.md`.

**Pago por monto, no `full:true`:** el paso 3 envía `amount` = monto cobrado en
centavos **excluyendo** el tip (`amount = order.total − tip`; el `tip` va aparte).
Decisión de producto: registrar el monto real cobrado en Omnivore en lugar de
"pagar el balance completo". Construido en `getPaymentStructureForCreateOmnivoreTicket`.

**Persistencia en `orders`** (paridad con el legacy):
- éxito de `create_order` → `omnivore_pos_id`, `pos_id`, `global_pos_id`, `pos_injection_error = null`.
- fallo terminal (dead-letter) de cualquier step → `pos_injection_error` (slug Omnivore).

## 3. Inyección de pago independiente

Reemplaza `sendPaymentToOmnivore`. La edge (`enqueueOmnivorePaymentInjection`)
replica **exactamente** los guards legacy: `status='completed'`, exactamente una
orden ligada, y **`orders[0].pos_id` existente** — si no hay ticket aún, **no
encola** (igual que el legacy hacía no-op).

**Anti doble-pago (crítico):** además, **no encola si ya existe un job
`order_injection` para esa orden** — porque ese job ya aplica el pago en su paso 3.
El pago standalone queda SOLO para órdenes con `pos_id` pero **sin** inyección MCM
(= traídas por el sync de Omnivore). Esto cierra la ventana de doble cobro que abre
el split en 3 pasos (donde `pos_id` se persiste en el paso 1, antes del pago).

Payload: `{ payment_id, order_id, ticket_id, payment: {...} }`. El handler
`payment_injection` salta si `payments.pos_id` ya está seteado (resume), aplica
el pago, y persiste `payments.pos_id`. Fallo terminal → `orders.issues`.

## 4. Sync (Omnivore → MCM)

`handlers/omnivore/sync/`:
- `order-mapper.ts`: `fetchOmnivoreOrders(client, 'today'|'open')` (query RQL
  `where=...`, `fields=...`, paginación HAL `_links.next`) + `convertOmnivoreOrderToMCMOrder`
  (+ desglose de impuestos) — portados verbatim del legacy (dayjs → `Date`).
- `upsert-orders.ts`: `upsertOmnivoreOrders` — dedup por `(site_id, omnivore_pos_id)`,
  guard `channel='pos'`, `verifyOrderHasRelevantChanges`, insert con `global_pos_id`.
  **GUARD anti-doble-cobro (`orderHasAppliedPayment`)**: si la orden existente ya
  tiene un `payments` con `status='completed'`, se **preservan** sus campos de pago
  (`status`/`payment_status`/`paid`) antes de comparar/actualizar. Sin esto, cuando
  un pago en MCM no se inyecta a Omnivore, Omnivore reporta la orden abierta
  (`due>0`, `paid=0`) y el sync la reabría a `new-order`/`not_fulfilled`/`0` →
  re-pagable (doble cobro). Fuente de verdad = tabla `payments` (NO
  `orders.payment_status`/`paid`, que el propio sync sobrescribe). Mismo guard en el
  edge: `_shared/helpers/omnivore-helper.ts::orderHasAppliedPayment` (usado por
  `syncOmnivoreOrdersIntoMCM` → `sync-orders` + `resync-orders-by-id-for-payment`) y
  `receive-omnivore-order-webhook`. **Requiere redeploy del worker** para activar el
  guard en el camino recurrente (las funciones edge ya se desplegaron). NO se usa un
  trigger global de DB porque rompería el `reopen-check` legítimo (manager PIN).
- `fetch-recent-orders.ts`: handler `omnivore.fetch_recent_orders`. Trae los
  tickets de **hoy** (abiertos **y** cerrados, ventana PR UTC-4) para capturar
  los cierres **sin** el webhook, hace upsert y `complete_sync_schedule`.

**Scheduling**: el dashboard llama `ensure_sync_schedules(site, 'omnivore', enabled)`
al guardar la integración con `syncOrdersAutomatically` → crea la fila
`sync_schedules (omnivore, fetch_recent_orders, 60s)`. El scheduler
(`claim_due_schedules`, leader-elected) encola un job `pos_sync` cada 60s;
el leader lock evita doble corrida.

## 5. Clasificación de errores (`error-map.ts`)

Omnivore devuelve `{ errors: [{ error: "<slug>", description, metadata.pos_error }] }`
y a menudo con HTTP **no-5xx**. Por eso **el slug manda sobre el status HTTP**:
- transitorios (`pos_not_responding_retry`, `timeout`, `agent_offline`,
  `pos_offline`, `cache_still_loading`, `internal_error`) → **retry**.
- de negocio (`reference_not_found`, `invalid_payload`, `ticket_closed/locked`,
  `excessive_*`, `out_of_stock`, `table_unavailable`, `tips_not_allowed`,
  `param_not_supported`, …) → **no-retry → dead_letter (NEEDS_REVIEW)**.
- ambiguos (`pos_failure`, `unknown`, `bug`) → retry acotado por `max_attempts`.

`mapOmnivoreError` devuelve un `HandlerError` con el `retryable` correcto;
`assertNoOmnivoreErrors` cubre el caso de HTTP 200 con `errors`.

## 6. Máquina de estados (spec → job-engine)

| spec | job-engine |
|---|---|
| PENDING | `status='pending'` |
| OPENING_TICKET / ADDING_ITEMS / ADDING_PAYMENTS | step running (`current_step_name`) |
| COMPLETED | `status='completed'` |
| FAILED / NEEDS_REVIEW | `status='dead_letter'` + `last_error` (slug) |

## 7. Cutover (big-bang) y kill-switch

Sin flag por tenant. Kill-switch global por env en la edge:
`OMNIVORE_INJECT_VIA_JOB_ENGINE` (default **ON**). Ponerlo en `"false"` revierte
a la inyección inline legacy (el builder/POST legacy se conservó intacto).

**Prerrequisitos de deploy (en orden):**
1. Worker `pos_injection` (y `pos_sync` con scheduler) **desplegado y corriendo**
   antes de activar el cutover (si no, los jobs se acumulan en `pending`).
2. `deno check` + deploy de las edge functions modificadas:
   `omnivore-endpoints`, `order-notification-status-change-trigger`,
   `_shared/sevices/payments-service` (helper compartido).
3. Decomisionar **operativamente** el webhook y el poll legacy (ver §8).

## 8. Decomisión del webhook + `sync-orders` legacy

No se borró código (no desplegable desde aquí, y la co-existencia es inocua:
ambos caminos deduplican por `omnivore_pos_id` y guardan `channel='pos'`). Pasos
operativos:
- **Desregistrar el webhook** del lado de Omnivore (deja de llamar
  `receive-omnivore-order-webhook`).
- Detener cualquier scheduler externo que pegue a `sync-orders`.
- Los syncs **interactivos** (`orderandpay-login`, `resync-orders-by-id-for-payment`)
  siguen en la edge (resultado inmediato) — NO se tocan.

## 9. Qué se verificó / qué falta

- ✅ `tsc --noEmit` limpio; unit tests de `error-map` y del handler `create_order`.
- ⏳ Falta (requiere deploy): `deno check` de la edge, smoke E2E contra Omnivore Dev,
  y alta de `sync_schedules` para el site Omnivore (via toggle en dashboard).

## Fix 2026-06-10 — Modifiers en el sync + reenvío de pago Clover→Omnivore

**Modifiers (Omnivore→MCM):** `order-mapper.ts::convertOmnivoreOrderToMCMOrder` ahora pide
`modifiers(id,name,price,quantity,comment,menu_modifier(id,pos_id),modifier_group(id,pos_id,name))`
en `FIELDS` y mapea `item._embedded.modifiers[]` (vía `mapOmnivoreItemModifiers`) a:
- `attributes[]` (flat: `{id, label:group_name, value:modifier.name, price:(m.price/100), tax_class}`)
  — para display/recibos y el note de Clover;
- `additional_properties.omnivoreParams[]` (contrato de re-inyección: `{modifier: menu_modifier.id,
  modifier_group: modifier_group.id, quantity, comment?, modifiers?:nested}`) — round-trip a Omnivore.
`item.price` queda inclusivo (no se separa el surcharge). **Idéntico** al edge
`omnivore-helper.ts::mapOmnivoreItemModifiers` (mantener en sync). Test `omnivore-convert-order.test.ts`.

**Reenvío de pago (consumer):** el handler `omnivore.payment_injection` ahora acepta
`jobPayload.pos_id_field` (default `pos_id`). El pull de pagos Clover lo invoca con
`additional_properties.omnivore_payment_id` como marca de "aplicado" (su `pos_id` ya es el id del pago
Clover). Cuerpo armado por `omnivore/inject/build-payment-body.ts` (port byte-equivalente de
`buildOmnivorePaymentBody`, incluye tip). Ver `docs/clover-integration.md §10`.
