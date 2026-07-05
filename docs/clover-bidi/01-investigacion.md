# Fase 1 — Investigación / formalización del estado actual

> Objetivo: dejar por escrito, verificado contra código on-disk, el estado del **MCM Job Engine**,
> de **Omnivore** (referencia dorada), del **Clover pre-existente**, y del **contrato POS/O&P
> provider-agnóstico**, para fundamentar el diseño aditivo de la bidireccionalidad Clover.
> Fecha de la corrida: **2026-07-02**. Nada de esto altera producción (lectura + formalización).

---

## (a) MCM Job Engine — anatomía

Motor de jobs distribuido para MCM POS. **Sin broker externo**: Postgres hace todo vía
`pg_notify`, advisory locks y `pg_cron`. TypeScript/Node/Express + Supabase, Vitest.

### Tablas núcleo

| Tabla | Rol |
|---|---|
| `integration_jobs` | 1 fila por job. `status` (pending/running/retrying/completed/dead_letter/cancelled), `queue_name`, `integration`, `job_type`, `site_id`, `payload` jsonb, `context` jsonb (acumula outputs de steps), `idempotency_key` UNIQUE, `locked_until`, `scheduled_for`, `correlation_id`. |
| `job_steps` | Steps ordenados de un job (`step_name`, `input`, `max_attempts`, `status`, `output`). |
| `job_step_attempts` | Bitácora de cada intento por step (error, timestamps). |
| `dead_letter_jobs` | Fila insertada cuando un job agota reintentos → dispara alerta email (dedupe 5 min). |
| `sync_schedules` | Cron declarativo per-tenant: `(site_id, integration, sync_type)` UNIQUE, `interval_seconds`, `status` enum `schedule_status` (active/disabled/…), `next_run_at`, `last_cursor`, `config` jsonb. |
| `alerts_outbox` | Cola de alertas operativas (drenada por el alert dispatcher vía Resend). |
| `integration_concurrency_limits` | Límite de paralelismo por `(queue, integration, site)`. **Capa paralelismo, NO rate.** |
| `clover_payment_map` | (Clover) dedup + anti-loop del pull de pagos: UNIQUE `(site_id, clover_payment_id)`, liga `mcm_payment_id`. RLS. |

### Flujo enqueue → claim → execute → retry → DLQ

1. **Enqueue** — `enqueue_job(...)` RPC; `ON CONFLICT (idempotency_key) DO NOTHING` (idempotencia a nivel DB). Trigger dispara `pg_notify('jobs_<queue>', job_id)`.
2. **Claim** — `claim_next_job(worker_id, queue, lock_seconds, integrations[])` con `SELECT … FOR UPDATE SKIP LOCKED` + chequeo de `integration_concurrency_limits`. Job → `running`, `locked_until = now()+180s`.
3. **Execute** — `src/core/executor.ts` itera steps en orden: resuelve handler vía `registry.get("integration.step_name")`; consulta circuit breaker (si abierto → fail-fast); `heartbeat_job()` cada 60s extiende el lock; en éxito `complete_step()` fusiona el output en `integration_jobs.context` bajo la clave del step (el siguiente step lee `context.create_order.order_id`); en error clasifica retryable → `fail_step(id, err, next_retry_at)` o dead-letter → `fail_step(id, err, null)`.
4. **Retry** — job → `retrying`, `scheduled_for` = backoff exponencial, re-encolado.
5. **Dead letter** — job → `dead_letter`, fila en `dead_letter_jobs`, alerta email (dedupe 5 min).
6. **Recovery** — `pg_cron` corre `recover_stuck_jobs()` cada minuto: cualquier `running` con `locked_until < now()` → `retrying`. Zombie máx ≈ 180s + 1 min ≈ 4 min.

### Piezas transversales

- **Circuit breaker (`src/core/circuit-breaker.ts`)** — máquina de estados **in-memory por proceso worker** (no compartida entre réplicas). Estado por **integración**; en el keying operativo de las queues de sync el breaker relevante es **`clover:pos_sync`** (todos los sync Clover corren en la queue `pos_sync` y comparten esa instancia). Umbral `CB_THRESHOLD=10` fallos en `CB_WINDOW_SECONDS=60`; cooldown `CB_COOLDOWN_SECONDS=300` antes de half-open.
- **Scheduler + leader lock (`src/scheduler/`)** — poll de `claim_due_schedules()` cada 5s. Singleton vía `pg_advisory_lock` (`LEADER_LOCK_KEY = 4815162342`); por convención solo `worker-pos-sync` corre con `RUN_SCHEDULER=true` y `RUN_ALERT_DISPATCHER=true`.
- **`registerHandler(integration, step)` + `load-handlers`** — cada archivo de handler se auto-registra al importarse; `src/handlers/registry.ts` (map `"integration.step_name" → Handler`) + el módulo de carga importan todos los archivos. Agregar un handler = nuevo archivo + su import.
- **`getSiteIntegrationConfig(site_id, provider, type)` (`src/lib/credentials.ts`)** — resuelve credenciales/config por tenant desde `site_integrations`.
- **`createCloverClient(config, correlationId)` (`src/handlers/clover/client.ts`)** — Axios con `baseURL = <base>/v3/merchants/{merchantId}`, headers `Authorization: Bearer`, `User-Agent: MyCloudMenu-JobEngine/1.0` (Clover lo exige), `X-Correlation-Id`, timeout 20s. `baseURL` delega en `resolveCloverBaseUrl` (ver §Slice A).
- **`mapCloverError(err, code)` (`src/handlers/clover/error-map.ts`)** — 429 retryable honrando `Retry-After`; 401 no-retryable (`CLOVER_UNAUTHORIZED`, token estático sin refresh); 5xx/red retryable; otros 4xx no-retryable (`NEEDS_REVIEW`).

### 4 queues / 4 workers (misma imagen Docker, `WORKER_QUEUE_NAME` distinto)

`pos_injection` · `pos_sync` (+ scheduler + alert dispatcher) · `notifications` · `webhooks`.

### Inventario de migraciones (001–028)

| # | Contenido |
|---|---|
| 001 | Enums, tablas núcleo, índices, RLS, triggers NOTIFY |
| 002 | Stored procedures (enqueue/claim/complete/fail/heartbeat/recover/retry/bulk_retry/claim_due_schedules/enqueue_alert) |
| 003 | `pg_cron`: `recover_stuck_jobs` (1 min) + cleanup diario |
| 004 | Vistas de monitoreo |
| 005 | Límites de concurrencia por defecto (seed) |
| 006 | Acceso admin del dashboard (`is_mcm_super_admin`, `admin_retry_dead_letter_job`) |
| 007 | `ensure_sync_schedules` (base) |
| 008 | `clover_payment_map` (dedup + anti-loop + voids/refunds) |
| 009 | Schedule `clover.fetch_payments` (configurable) |
| 010 | `clover_payment_map` revoke anon/authenticated |
| 011 | Sync granular por `sync_type` |
| 012 | `trigger_sync_now` |
| 013 | Schedule `clover.push_orders` (MCM→Clover recurrente) |
| 014 | **BUGFIX** cast `::schedule_status` en cada CASE de `ensure_sync_schedules` (sin él nunca creaba filas) |
| 015 | `requeue_job` / `admin_requeue_job` (reintento manual + editar payload) |
| 016 | UNIQUE parcial `payments(site_id,pos_id) WHERE pos_id IS NOT NULL` + upsert |
| 017 | `claim_due_schedules`/`trigger_sync_now` serializan por `(site,integration,sync_type)`; `complete_sync_schedule` avanza cursor monótono |
| 018 | RPC `claim_clover_supplement` + `set_clover_supplement_clover_id` |
| 019 | Schedule `omnivore.fetch_tables` |
| 020 | Schedule `omnivore.fetch_products` |
| 021 | Schedule `omnivore.fetch_employees` (rama omnivore que la mig 028 copia byte-for-byte) |
| 022 | `complete_sync_schedule` preserva `disabled` |
| 023 | Pace de concurrencia Omnivore |
| 024 | Auto-retry de dead-letters transitorios |
| 025 | Queue `order_actions` |
| 026 | Queue `printing` |
| 027 | Cron de printing |
| **028** | **NEW (clover-bidi)** — extiende `ensure_sync_schedules`/`trigger_sync_now` (rama omnivore byte-for-byte + filas Clover catálogo flags OFF) + backfill `disabled` + tablas `clover_inventory_sync_log`/`clover_employee_sync_log` (RLS) |

---

## (b) Omnivore — referencia dorada

Arquitectura **Opción A**: la edge (Deno) arma los payloads (`omnivore-helper` verbatim) y el
job-engine solo los **entrega** con retry/backoff/DLQ/idempotencia/resume. Divergencia byte-a-byte
estructuralmente imposible.

- **Inbound (poll):** `omnivore.fetch_recent_orders` — trae tickets de hoy (abiertos + cerrados, ventana PR UTC-4), `upsertOmnivoreOrders` dedup por `(site_id, omnivore_pos_id)`, guard `channel='pos'`, guard anti-doble-cobro `orderHasAppliedPayment` (fuente de verdad = tabla `payments`).
- **Outbound (3 pasos):** `create_order` (`POST /tickets`, adopta ticket abierto por nombre `MCM {order_id}`) → `add_items` (`POST /tickets/:id/items`, salta si ya hay items) → `create_payment` (`POST /tickets/:id/payments`, por monto excl. tip). Header `Idempotency-Id` (no `-Key`) + guard propio por step. (Aloha: header muerto → fallback por escaneo de tickets abiertos.)
- **Sync de catálogo:** convención `additional_properties.omnivoreId` en filas MCM; empleados por `(site_id, login=PIN)`; mesas en `floor_elements.external_source`; modifiers → `attributes[]` + `additional_properties.omnivoreParams[]`.
- **Idempotencia MCM-side:** dedup por ids POS persistidos, no confía solo en headers del POS.

Estas cuatro convenciones (`*Id` en `additional_properties`, empleados por PIN, mesas en
`floor_elements`, idempotencia MCM-side) son las que Clover **espeja** en el diseño aditivo.

---

## (c) Clover pre-existente (producción) — qué ya existe (NO tocar)

| Capacidad | Detalle |
|---|---|
| **Orden outbound** | `clover.create_order` (adopt-by-`externalReferenceId` o `POST /orders`, persiste `clover_ticket_id`) → `clover.reconcile_items` (DELETE+RECREATE `bulk_line_items` + `POST /orders/:id {total}` en centavos; guard `CLOVER_ORDER_HAS_PAYMENTS`; guard 3000 items). Idempotente/convergente. |
| **Suplementarias** | `supplemental_order_injection` — add post-pago en 2ª orden Clover ligada a la misma orden MCM; RPC `claim_clover_supplement` (mig 018); manifest en `orders.additional_properties.clover_supplemental`. |
| **Orden inbound (pull)** | `clover.fetch_open_orders` (60s) / `clover.fetch_closed_orders` (300s) → `upsertOrdersFromClover`, dedup por `clover_pos_id`, guard `orderHasAppliedPayment` anti-doble-cobro. |
| **Pagos** | `clover.payment_injection` (Idempotency-Key `mcm-clover-pay-{site}-{paymentId}`, escribe `clover_payment_map`); `clover.fetch_payments` (30s, watermark `modifiedTime` con OVERLAP 2min + defer-protect; voids/refunds/tips; reenvío a Omnivore con tip). |
| **Tax push** | Escala **1e7**, tenant-aware (`config.cloverTaxRateIdByRateCode`), fuente `fees-engine.loadTaxRates`. |
| **Auth** | Token **estático** per-site (merchant API token). Sin refresh OAuth. |
| **Columnas `orders`** | `clover_pos_id`, `clover_ticket_id`, `clover_payment_id`, `clover_line_items_hash`, `pos_injection_error`. |
| **Modifiers MCM→Clover** | Como **nota** de la línea (Clover no acepta modifications ad-hoc por REST; `price` de línea inclusivo). |

**Dead code (NO modelar ni borrar):** `clover/inject/create-payment.ts` (no registrado);
`getCloverTaxRates`/`getApplicableTaxRates` (DEPRECATED, bug 10×).

**Gaps vs Omnivore (motivo de esta corrida):** no había sync programado de catálogo (empleados,
modificadores nativos, inventario/86 con scheduler), ni resolución de región/base-URL, ni scaffold
OAuth.

---

## (d) Contrato POS / Order&Pay — provider-agnóstico (CERO cambios necesarios)

Hallazgo que reduce alcance: `app/pos-order` y Order&Pay **renderizan solo desde columnas
canónicas** de `orders`/`line_items`; la tarjeta de live-orders ya lee
`clover_pos_id || clover_ticket_id`. El catálogo (products/categories/ingredients) también se
consume por columnas canónicas, no por proveedor. **Conclusión: importar catálogo Clover a las
mismas tablas (keyed por `cloverId`) es transparente para el POS.** No se tocan ni POS ni O&P.

---

## (e) Riesgos y preguntas abiertas (entrada a las guardas y a BLOQUEOS)

| Riesgo | Estado |
|---|---|
| Circuit breaker compartido `clover:pos_sync` — un burst de 429 del primer sweep de catálogo frenaría el pull de órdenes/pagos de producción | Mitigado con **token-bucket per-site** delante del catálogo (G1). No se cambia el keying del breaker. |
| `ensure_sync_schedules`/`trigger_sync_now` sirven a Omnivore Y Clover | Copiar rama Omnivore **byte-for-byte**, solo anexar filas Clover, flags default OFF, backfill `disabled` (G2). Regresión Omnivore obligatoria. |
| `CloverConfigSchema` está en el hot-path de injection | Todo campo nuevo `.optional()`/`.default(false)`, nunca `.strict()` (G3). |
| Offset de Clover capado (~1000) | Paginación con cap+log; cursor por `modifiedTime` para catálogos enormes = follow-up (G6). |
| Watermark envenenado por timestamps far-future del sandbox | Clamp `≤ now()+skew` antes de avanzar el cursor monótono (G7). |
| Un solo merchant sandbox `7ES0TRRRYJCY1` | Aislamiento cross-merchant a nivel API **no testeable**; se cubre row/control-plane (site A ON vs site B sin Clover). |
| OAuth expiring tokens | No testeable sin app OAuth registrada; se documenta como deferred. |
| Órdenes Clover NO traen `table`/`employee` (spike P1.5) | `fetch_tables` floor-layout-only/deferred; enrichment de mesa no factible desde Orders API. |
| Modificadores nativos `/modifications` no dedupean (P1.6) | Feasible pero requiere idempotencia MCM-side + edge → deferred; fallback de nota intacto. |
| Refund/void live en tender externo offline | HTTP 405 en sandbox; cubierto por unit tests; live pendiente de pago con tarjeta / Dashboard. |
