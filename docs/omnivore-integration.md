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

sync_schedules (omnivore/fetch_open_orders)  handlers/omnivore/sync/
  ← ensure_sync_schedules RPC (dashboard)      fetch_open_orders   → 20s · eq(open,true)
sync_schedules (omnivore/fetch_closed_orders)  fetch_closed_orders → 90s · ventana 24h + open
                                              (fetch_recent_orders → retirado, ver §4)
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
### Dos carriles (2026-07-27)

Antes había **un solo** schedule, `fetch_recent_orders` (60s), cuyo handler hacía las dos
pasadas juntas. Medido en Dev, ese ciclo tardaba **68–84 s** (la API son ~15 s; el resto es
el `SELECT` por ticket del loop de upsert, ~162 ms × 197), así que una mesa lista para
cobrar tardaba más de un minuto en aparecer. Ahora está partido:

| `sync_type` | Intervalo | Query | Para qué |
|---|---|---|---|
| `fetch_open_orders` | **20 s** | `eq(open,true)` | Carril rápido. Una sola pasada, ~66 tickets, ciclo medido ~19 s. Es la MISMA query que `orderandpay-login` ya dispara en cada login de mesero. **No detecta cierres** (un ticket cerrado desaparece de `eq(open,true)`). |
| `fetch_closed_orders` | **90 s** | `and(gte(opened_at,now-24h),lte(opened_at,now+60))` **+** `eq(open,true)`, dedup por id | Barrido completo — el cuerpo de `fetch_recent_orders` sin cambios. Es quien **detecta los cierres** sin el webhook: la ventana trae los tickets del período abiertos *y* cerrados. |

- `fetch-open-orders.ts` / `fetch-closed-orders.ts`: los dos handlers. Ambos escriben por el
  mismo `upsertOmnivoreOrders`, que ya es seguro ante ejecuciones concurrentes (UNIQUE
  `(site_id, omnivore_pos_id)` + upsert `ignoreDuplicates`, freshness guard por
  `omnivore_synced_at`, CAS sobre `date_updated`, guard `orderHasAppliedPayment`).
- `fetch-recent-orders.ts`: **retirado pero NO borrado**. Su fila de schedule quedó
  `disabled` y el handler sigue registrado, para los jobs en vuelo y para el rollback
  (reactivar esa fila y desactivar las dos nuevas).
- La ventana rodante bajó de **36 h a 24 h** (`order-mapper.ts::getTodayWindowUnix`). 24 h
  siguen cubriendo el cruce de medianoche. Hueco conocido: un ticket abierto hace más de 24 h
  que se cierra ahora sale del pase `open` y queda fuera de la ventana ⇒ su cierre no
  sincroniza. Si hace falta cerrarlo, la vía verificada contra la API es
  `and(eq(open,false),gte(closed_at,now-24h))`.

**Los 20 s / 90 s son un objetivo, no una garantía.** Una página de `/tickets` cuesta 4–9 s
aunque se pidan campos mínimos (la latencia es del agente Aloha, no del payload), y el loop de
upsert suma ~162 ms por ticket. El gate de serialización de `claim_due_schedules` impide que se
acumulen jobs: **se pierden ticks en vez de encolarse**.

Medido en Dev el 2026-07-27, sobre 8 min de corrida real:

| Site | Rápido (avg / cadencia real) | Lento (avg / cadencia real) | Antes (carril único) |
|---|---|---|---|
| 51021421 · 0 abiertas | 0.9 s / **20 s** | 96.9 s · 451 tickets / 184 s | — |
| 25612612 · 69 abiertas | 18.2 s / **24 s** | 56.3 s · 201 tickets / 94 s | 44–55 s |
| 99990003 · 69 abiertas | 24.5 s / **39 s** | 76.2 s · 201 tickets / 80 s | 68–84 s |

O sea: lo abierto pasó de refrescarse cada 44–84 s a cada 20–39 s. La cadencia se degrada con
el número de mesas abiertas simultáneas, y el carril lento se pasa de 90 s en los sites con
muchos tickets en la ventana.

**Timeouts conocidos (decisión consciente).** `client.ts` usa `timeout: 20_000` compartido con
la inyección. En la corrida de arriba eso produjo **5 `timeout of 20000ms exceeded` en 20 min**
(dos de ellos cortando el carril rápido justo a los 20003 ms, a mitad de la paginación). Los
reintentos los absorben —0 dead-letters, todos los schedules en `consecutive_failures = 0`—
pero se pierde ~1 de cada 12 ciclos. Se decidió NO subirlo para no tocar también el path de
fire/void síncrono. Si algún día se quiere arreglar, la vía es un timeout opcional por cliente
usado solo desde estos dos handlers (recomendación de `audits/2026-06-13`, 40 s).

**Scheduling**: el dashboard llama `ensure_sync_schedules(site, 'omnivore', enabled)` al
guardar la integración; el **mismo** flag de siempre (`syncOrdersAutomatically`) gobierna los
dos carriles. El scheduler (`claim_due_schedules`, leader-elected) encola un job `pos_sync`
por carril; el leader lock evita doble corrida.

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

### Excepción: `ticket_locked` en `payment_injection` (2026-07-27)

`ticket_locked` = el mesero tiene el ticket abierto en el terminal. Sigue siendo error de
negocio terminal en todos lados **menos** en el job standalone `payment_injection`, donde el
dinero ya se cobró en MCM y tiene que llegar al POS sí o sí. Ahí el handler
(`inject/payment.ts`) lo trata como **contención** y no como fallo permanente:

- Sube el techo del propio step a **31 intentos** (`UPDATE job_steps SET max_attempts`, más la
  mutación en memoria para que el executor lo vea en la misma pasada). Se hace desde el worker
  y no en el productor porque cambiar el `max_attempts: 5` del edge obligaría a redesplegar
  ~20 edge functions del camino de cobro.
- Reintenta con un ritmo **plano de 60 s** (±10 % de jitter) vía `HandlerError.retryAfterSeconds`,
  que el executor honra por encima del perfil de backoff ⇒ el perfil compartido
  `payment_injection: [30,30,30,30]` queda intacto para el resto de errores y para Clover.
  **31 × 60 s ≈ 30 min** de cobertura.
- El ritmo plano de 60 s es lo que hace innecesario tocar el circuit breaker: a 1 fallo por
  minuto harían falta ~10 pagos trabados a la vez para acercarse al umbral (10 fallos/60 s), y
  cualquier inyección exitosa limpia el contador.
- Marca `orders.issues` **desde el primer fallo** (sin esperar a `willTerminate`) para que el
  pago pendiente sea visible durante la espera. Es un slot JSONB único que se sobrescribe, y
  `reconcileOrderIssues` lo pone en `null` cuando el pago finalmente entra.

Reintentar no duplica el tender: el guard de reconcile-before-repost (`payment.ts`, activo con
`attempt_count > 0`) corre en cada reintento y, si un intento previo llegó a aplicar el pago,
lo detecta por `comment` + `amount` y sale sin re-postear. Si el mesero **cierra** el ticket
durante la espera, el siguiente intento devuelve `ticket_closed` → terminal, como debe ser.

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
