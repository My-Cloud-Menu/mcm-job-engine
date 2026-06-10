# Clover POS integration — migración a `mcm-job-engine`

> Migra los flujos Clover (push de órdenes con reconciliación, inyección de pago,
> pull de pagos) del edge al job-engine, **espejo de Omnivore**, con tax robusto.
> Arquitectura **Opción A**: el edge construye los payloads (reusando
> `clover-helper`) y el job-engine **entrega + reconcilia + hace el pull** con
> retry/backoff/DLQ/resume/leader-election. No hay abstracción POS formal — es
> convención (`registerHandler(integration, step)` + carpetas por proveedor).

## 1. Push de órdenes MCM→Clover (create + reconcile)

Job de inyección Clover = **2 steps** (a diferencia de Omnivore, el pago NO va aquí):

| step | acción |
|---|---|
| `clover.create_order` | adopta orden Clover por `externalReferenceId` (`GET /orders?filter=externalReferenceId=`) o `POST /orders` con el body congelado; persiste `orders.clover_ticket_id`. Dedup/resume header-independiente. |
| `clover.reconcile_items` | short-circuit si `orders.clover_line_items_hash` == hash deseado; `GET /orders/:id?expand=lineItems,payments`; **guard `CLOVER_ORDER_HAS_PAYMENTS`** (#12, no mutar pagadas); guard **3000 items** (#9); **DELETE+RECREATE** (`bulk_line_items`) del set congelado; **`POST /orders/:id { total: order_total_cents }`** tras el bulk (set del total, ver §1b); persiste hash. Convergente/idempotente. |

- Edge `enqueueCloverInjection(order)`: idempotency_key `clover_inject:{order}:{hash}` → **re-encola al cambiar** la orden, dedup si el hash no cambió.
- El edge `buildCloverInjectionPayload` congela `{ order_id, external_reference_id, order_body, line_items, line_items_hash, order_total_cents }`.

### 1b. Set explícito de `order.total` (fix `total $0.00` en Register, 2026-06-10)

Clover **no recalcula** `order.total` al agregar ítems vía `bulk_line_items` (verificado en vivo: orden con
ítems, e incluso `PAID`, seguía con `total=None` → el Register mostraba **$0.00**; el recibo sí sumaba al
vuelo). Fix: `buildCloverInjectionPayload` setea `order_body.total` y expone `order_total_cents` =
`Σ(price + taxAmount)`; el handler `reconcile_items` re-asienta el total con `POST /orders/:id { total }`
**después** del bulk add — orden importa porque el bulk puede dejar el total stale/cero, y en una **edición**
`create_order` adopta la orden sin re-POST, así que este es el único punto que mantiene el total al día.
Guard `> 0`; el POST es no-fatal (los ítems ya quedaron; el total es display). `total` es campo escribible
del request body de create/update (Clover docs).

## 2. Tax robusto (corrige 3 fallas del builder)

`buildCloverLineItemsWithTaxes` (edge) reescrito:
1. **Escala 1e7** (antes `/1_000_000` = 10× incorrecto). `rate` a Clover = `round(rate × 1e7)`; `taxAmount = round(priceCents × rate)`.
2. **Fuente autoritativa**: rates por línea desde `fees-engine.loadTaxRates(site, country)` (tabla `tax_rates`, fracción), NO adivinanza por nombre/magnitud. Se eliminó `getCloverTaxRates`/`getApplicableTaxRates`.
3. **Mapeo explícito por tenant**: `rate_code` → `config.cloverTaxRateIdByRateCode[rate_code]` (id real de Clover). **Fail-loud** (`CloverTaxRateNotMapped` → `NEEDS_REVIEW`) si falta.

## 3. Inyección de pago MCM→Clover

`clover.payment_injection` (1 step). Edge `enqueueCloverPaymentInjection`: guards legacy (status completed, 1 orden, ticket = `clover_ticket_id || pos_id`). **Sin** guard anti-`order_injection` (el job de inyección Clover no aplica pago → este es el único camino). idempotency `clover_pay:{payment_id}`. El handler: skip si `payments.pos_id` ya seteado; aplica; persiste `payments.pos_id` + fila en **`clover_payment_map`** (para dedup/anti-loop del pull).

## 4. Pull de pagos Clover→MCM (scheduled, watermark `modifiedTime`)

`clover.fetch_payments` (reemplaza `clover-payment-notification`):
- `GET /payments?filter=modifiedTime>={watermark − overlap 2min}&expand=order,refunds`, paginado.
- **Dedup** por `clover_payment_map` (UNIQUE site_id, clover_payment_id).
- **Anti-loop**: salta los inyectados por MCM (mapeados o con `payments.pos_id == clover id`).
- **Voids/refunds**: refleja `voided`/`total_refunded` posteriores (el watermark por `modifiedTime` los re-trae).
- Órdenes aún no sincronizadas → se dejan para el próximo ciclo (no se pierden).
- Avanza `sync_schedules.last_cursor = max(modifiedTime)`. Leader election evita doble corrida.
- **Cadencia configurable por tenant** (`config.cloverPaymentSyncIntervalSeconds`, default 30s), provisionada por `ensure_sync_schedules`.

## 4b. Pull de órdenes Clover→MCM + GUARD anti-doble-cobro (2026-06-10)

`clover.fetch_open_orders` / `fetch_closed_orders` → `upsertOrdersFromClover`
(`src/handlers/clover/sync/upsert-orders.ts`) traen órdenes de Clover y upsertean en
`orders` (dedup por `clover_pos_id`). **Mismo bug-class que el sync de Omnivore:**
`convertCloverOrderToMCMOrder` pone `payment_status='not_fulfilled'`/`status='new-order'`
salvo que Clover diga `paymentState='PAID'`. Si se paga en MCM y la inyección del pago a
Clover falla, Clover reporta la orden abierta → el sync la reabría a
`new-order`/`not_fulfilled`/`paid=0` → re-pagable (doble cobro).

**GUARD `orderHasAppliedPayment(site_id, order_id)`** (idéntico a Omnivore): si la orden
ya tiene un `payments` con `status='completed'`, se **preservan** `status`/`payment_status`/
`paid` antes de comparar/actualizar. Reemplaza un guard previo **débil** (que confiaba en
`orders.payment_status` + `total` sin cambios — falible porque el propio sync pisa esos
campos, y porque caía al update si el total difería). Fuente de verdad = tabla `payments`.
Mismo guard en el edge `clover-helper.ts::syncCloverOrdersIntoMCM` (reusa el helper de
`omnivore-helper.ts`; cubre `sync-orders` y `orderandpay-login`). NO trigger global de DB
(rompería `reopen-check` legítimo). Verificado: unit test `clover-payment-guard.test.ts`
(paridad con omnivore) + worker reiniciado con el guard. **Exposición:** el pull de órdenes
Clover→MCM solo manifiesta donde está activo (`sync_orders=true`).

## 5. Flujo combinado (Omnivore → MCM → Clover)

El sync Omnivore→MCM (`omnivore.fetch_recent_orders`) hace upsert de la orden → dispara
el webhook de DB `order-notification-status-change-trigger` → su rama Clover encola
`enqueueCloverInjection`. La reconciliación (idempotente/convergente) refleja add/void/change.
Cada integración es independiente (gateada por config del tenant); el combinado es solo orquestación.

## 6. Errores (`clover/error-map.ts`)

429 → retry honrando `Retry-After` (vía `HandlerError.retryAfterSeconds` + executor); 401 →
`NEEDS_REVIEW` (token estático, sin refresh OAuth); 5xx → retry; 4xx (400/403/404) → `NEEDS_REVIEW`.

## 7. Migraciones, kill-switch, decomisión

- **008** `clover_payment_map` (dedup + anti-loop + voids/refunds). **009** actualiza
  `ensure_sync_schedules` (añade `fetch_payments` configurable). Ambas aplicadas en Dev.
- **011** sync granular por sync_type, **012** `trigger_sync_now`, **013** `push_orders` (MCM→Clover recurrente).
- **014 (BUGFIX)** `ensure_sync_schedules` nunca creaba filas: `sync_schedules.status` es enum
  `schedule_status` y las expresiones `case … then 'active' else 'disabled' end` son `text`;
  Postgres no castea `text→enum` en INSERT salvo literal suelto (no el resultado de un CASE) →
  fallaba *"column status is of type schedule_status but expression is of type text"*. Síntoma: el
  sync automático Clover (push + pull de pagos) no corría aunque el dashboard guardara los flags;
  sólo "Probar ahora" (vía `trigger_sync_now`) funcionaba, y el de Pagos caía en `dead_letter`
  (`schedule_id` null) por falta de fila de schedule. Fix: `::schedule_status` en cada CASE.
  **Al desplegar a prod:** aplicar 014 **y** re-correr `ensure_sync_schedules(site, integration, active)`
  por cada integración clover/omnivore activa (backfill — las existentes tienen schedules faltantes
  hasta re-guardarse).
- Kill-switch edge `CLOVER_INJECT_VIA_JOB_ENGINE` (default ON; `"false"` → inline legacy intacto).
- El client manda el header **`User-Agent`** que Clover exige (el edge no lo mandaba).
- **Decomisión operativa** de `clover-payment-notification` + su trigger externo (no se borró código).

## 8. Verificado / pendiente

- ✅ `tsc` limpio; **tests Clover** (error-map, inject create/reconcile, payment, pull) verdes;
  tax math verificado (10.5% → 1,050,000 + 105¢).
- ✅ **Fix `total $0.00` (2026-06-10, §1b):** Deno `clover-reconcile` 2/2 + Vitest `clover-inject` 10/10
  (set-total tras bulk; NO set en skip por pagos). **Full-pipeline E2E en sandbox**: job 2-step real por el
  worker desplegado creó una orden Clover con `total=2115 == Σ line items`. Contrato API confirmado
  (`POST /orders/:id {total}` persiste). Edge desplegada: `order-notification-status-change-trigger`,
  `sync-orders-to-clover`; worker `pos_injection` reiniciado.
- ⏳ Falta (deploy): `deno check` de la edge, smoke E2E con worker corriendo el branch, UI de
  tax-mapping verificada en el dashboard. El tax del **pull** (Clover→MCM) sigue hardcodeado a PR
  (follow-up, fuera de scope).

## 9. Órdenes Clover suplementarias — add post-pago (2026-06-10)

**Problema:** Clover **no permite reabrir** una orden pagada/bloqueada (verificado en vivo: el campo
`state` es cosmético — "not checked or enforced by the Clover server"; no hay endpoint de reopen;
`bulk_line_items` y `line_items` rechazan agregar a una orden con pagos). Si tras pagar en Clover se
agrega un ítem en el POS de origen (Omnivore→MCM→Clover), `reconcile_items` antes **saltaba en
silencio** (`order_has_payments`) y el ítem se perdía en Clover.

**Solución:** cuando el primario ya está pagado, en vez de saltar se factura el ítem nuevo en una
**SEGUNDA orden Clover** (suplementaria) ligada a la misma orden MCM.

- **Modelo de datos (sin migración):** `orders.additional_properties.clover_supplemental` (jsonb):
  `{ primary:{clover_order_id, billed_keys}, supplements:[{external_reference_id, clover_order_id,
  delta_signature, delta_keys, total_cents}] }`.
- **Delta:** `computeDelta` (en `clover/inject/supplemental.ts`) = los `jobPayload.line_items`
  congelados (subconjunto, ya tax-correcto) menos lo ya facturado (`mergedBilledKeys` = primary +
  supplements). Key estable **`name||note`** (independiente del absorber de redondeo que mueve el
  `price` de UNA línea; el `note` ya codifica los modifiers). Para órdenes legacy (pagadas antes de
  esta feature) `billed_keys` se **siembra** desde los line items actuales del primario en Clover (que
  `reconcile_items` ya trae por GET).
- **Job nuevo `supplemental_order_injection` (2 steps):** `clover.create_supplemental_order`
  (adopta por manifest `delta_signature` → por `externalReferenceId` ≤12 chars → `POST /orders`;
  persiste el id en la entrada del manifest, **no** en `orders.clover_ticket_id`) + `reconcile_items`
  **reusado** con `jobPayload.supplemental=true` (resuelve el clover order id de
  `context.create_order ?? context.create_supplemental_order`, salta el short-circuit de hash del
  primario y no escribe `clover_line_items_hash`). Encolado por `enqueueCloverSupplementalInjection`
  (idempotency `clover_supp_inject:{order}:{deltaSig}`) desde `handlePaidPrimaryDelta`.
- **`reconcile_items` (primario):** el viejo skip silencioso se reemplaza por `handlePaidPrimaryDelta`,
  que SIEMPRE devuelve resultado visible: `{supplemental_enqueued}` (hay delta+), `{skipped:
  'no_delta_paid'}` (sin delta), o `{needs_review:'negative_delta'}` (se removió un ítem post-pago →
  `pos_injection_error` visible; refund sobre orden bloqueada → **diferido**, nunca pérdida silenciosa).
- **Pull de pagos (`upsert-payments.ts`):** un id de orden suplementaria no matchea
  `clover_ticket_id`/`clover_pos_id` → **fallback** por `additional_properties @>
  {clover_supplemental:{supplements:[{clover_order_id:X}]}}` (scoping `site_id`). El pago cae en la
  MISMA orden MCM (`orders_ids:[order.id]`), así que el acumulado Σ(payments.total) vs `order.total`
  suma primario + suplemento **sin doble-conteo**.
- **Verificado (sandbox Pala 7ES0TRRRYJCY1):** E2E real por el worker desplegado — job
  `supplemental_order_injection` → orden Clover suplementaria creada (state=open) con el ítem delta y
  `total` asentado; ambos steps `completed`. Unit tests `clover-supplemental.test.ts` (12) + delta
  puro (append-only / sin-delta / removal / cantidad) + adopt/create handler.

## 10. Reenvío de pago Clover→MCM→Omnivore (con tip) (2026-06-10)

**Bug:** un pago cobrado en un terminal Clover sincronizaba a MCM (`upsertCloverPayments` inserta el
pago **con su tip**) pero **nunca se inyectaba a Omnivore** — el fan-out a Omnivore sólo corría para
pagos originados en el POS de MCM (`payments-service.ts`), no para el pull. Falla **silenciosa** (sin
job → nada en `/admin/jobs`; el ticket de Omnivore quedaba abierto).

**Fix:** tras insertar un pago nuevo `completed`/no-voided, `upsert-payments.ts` encola un
`omnivore.payment_injection` **si** el sitio tiene Omnivore activo, `orders.pos_id` existe (= ticket
Omnivore) y no hay un `order_injection` de omnivore (anti-doble-pago). `max_attempts:4` (1 + 3
reintentos).
- **Marcador separado:** el handler `omnivore.payment_injection` ahora acepta
  `jobPayload.pos_id_field`; el reenvío usa `additional_properties.omnivore_payment_id` como marca de
  "aplicado", porque en un pago de Clover `payments.pos_id` YA es el id del pago **Clover** (si se
  reusara, el resume-guard saltaría y nunca aplicaría). Default sigue siendo `pos_id` (camino POS).
- El cuerpo Omnivore se arma con `omnivore/inject/build-payment-body.ts` (port de
  `buildOmnivorePaymentBody`, byte-equivalente al edge; incluye `tip`).
- **Idempotencia:** enqueue `pos_pay:omnivore:{paymentId}` + header `Idempotency-Id` a Omnivore.
- Tests: `omnivore-build-payment-body.test.ts`, `omnivore-payment-injection.test.ts` (modo marcador),
  `clover-pull.test.ts` (forward sí/no/voided).

## 11. `/admin/jobs`: reintento manual + editar payload (2026-06-10)

Migración **015** `requeue_job(job_id, actor, payload_override?)` + wrapper admin-gated
`admin_requeue_job(job_id, payload_override?)` (espejo de `admin_retry_dead_letter_job`/006:
`is_mcm_super_admin()` + actor del JWT, revoke public/grant authenticated). Resetea el job + steps a
`pending` (override → reset COMPLETO de todos los steps + limpia context; sin override → resume de los
no-completados), opcionalmente sobre-escribe `integration_jobs.payload`, resuelve `dead_letter_jobs`.
El trigger `tg_jobs_notify` re-notifica al worker en status→pending. Dashboard: botones "Reintentar" y
"Editar payload y reintentar" (editor JSON) en `/admin/jobs/[id]` para jobs terminales
(`dead_letter`/`completed`/`cancelled`).

## 12. Modifiers MCM→Clover = note (Clover NO acepta ad-hoc) (2026-06-10)

Verificado en vivo: `bulk_line_items` **descarta** un array `modifications` ad-hoc, y
`POST .../line_items/{id}/modifications` exige un `modifier` de **catálogo** (400 "Request must contain
a modifier object" / 404 si el id no existe). No es posible crear modifications ad-hoc por REST. Por
eso `buildItemNote` (clover-helper) deja los modifiers en el **note** de la línea, ahora con su
surcharge (ej. "Up Charge Tacos: Banderita (+$4.00)"), y el `price` de la línea queda **inclusivo**
(el total cuadra). El sync Omnivore→MCM (Parte A) sí captura los modifiers en `attributes` +
`omnivoreParams`, así que ahora aparecen en el note de Clover por primera vez.
