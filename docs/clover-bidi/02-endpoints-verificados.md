# Fase 2 — Endpoints Clover verificados

> Cada endpoint usado por la integración, con método, path, propósito, params clave, paginación,
> escala de dinero y URL de doc. Al final, los **hechos verificados en sandbox** (merchant
> `7ES0TRRRYJCY1`, "MCM Restaurant Test") durante la corrida del 2026-07-02.
> Regla del plan: verificar cada endpoint contra doc oficial o sandbox antes de usarlo; **si el
> sandbox difiere de la doc, gana el sandbox** y se documenta.

---

## Convenciones globales

- **Base path:** todo endpoint cuelga de `/v3/merchants/{mId}/…` (el `mId` = `config.merchantId`; el client lo baja al `baseURL`).
- **Auth:** `Authorization: Bearer <token estático per-site>` + `User-Agent` obligatorio.
- **Dinero:** enteros en **centavos int64** (`price`, `total`, `amount`, `taxAmount`). Nunca decimales.
- **Porcentajes / tax rate:** escala **1e7** (`rate = round(fracción × 1e7)`; p.ej. 10.5% → `1050000`).
- **Paginación:** `limit` (máx 1000) + `offset`. **El offset está capado (~1000).** Para colecciones grandes → cursor por `filter=id>lastId` (orden id) o por `modifiedTime`. En este repo `fetchAllCloverElements` pagina por offset con **cap+log** (`MAX_PAGES=60` → 6000 elementos) y registra `clover_catalog_pagination_capped`; el salto a cursor por `modifiedTime` es follow-up (BLOQUEOS).
- **Doc oficial:** `MCM/clover docs/` (repo local) + `https://docs.clover.com/reference`.

---

## Regiones (base URL, no auto-descubrible → per-site `config.apiUrl`/`config.region`)

| Región | Base URL | Verificación |
|---|---|---|
| US / NA | `https://api.clover.com` | doc oficial (default del código) |
| EU | `https://api.eu.clover.com` | doc oficial |
| LATAM | `https://api.la.clover.com` | doc oficial |
| Sandbox (REST, configurado) | `https://sandbox.dev.clover.com` | **200 en Fase 0** ✅ (host usado) |
| Sandbox (REST, doc oficial) | `https://apisandbox.dev.clover.com` | **200 en Fase 0** ✅ (ambos autentican) |

> **Host gate (Fase 0, resuelto):** el config del merchant traía `apiUrl = sandbox.dev.clover.com`
> mientras la doc indicaba `apisandbox.dev.clover.com`. `GET /v3/merchants/{mId}` dio **200 en ambos**
> → no hay bug; se usa el configurado por consistencia con producción.

---

## Endpoints por dominio

### Órdenes (inbound + outbound)

| Método | Path | Propósito | Params clave | Escala |
|---|---|---|---|---|
| `GET` | `/orders` | Pull de órdenes | `filter=modifiedTime>=…`, `filter=clientCreatedTime`, `expand=lineItems,payments`, `limit`/`offset` | total en centavos |
| `GET` | `/orders/{id}` | Reconcile / re-lectura | `expand=lineItems,payments` | centavos |
| `POST` | `/orders` | Crear orden (outbound) | body con `externalReferenceId` (**≤12 chars**), `total` | centavos |
| `GET` | `/orders?filter=externalReferenceId=…` | Adoptar orden por ref (dedup secundario) | — | — |
| `POST` | `/orders/{id}/bulk_line_items` | Add line items (DELETE+RECREATE) | requiere **`price` explícito** por línea | centavos |
| `POST` | `/orders/{id} { total }` | Asentar `order.total` tras el bulk (Clover no recalcula) | `total` en centavos | centavos |
| `POST` | `/orders/{id}/line_items/{liId}/modifications` | Modificadores nativos (spike, **deferred**) | `{ modifier:{id}, name, amount }` | centavos |

### Catálogo (Clover → MCM, source of truth = Clover)

| Método | Path | Propósito | Params clave | Doc |
|---|---|---|---|---|
| `GET` | `/categories` | Categorías → `categories` (por `cloverId`) | `id, name, sortOrder, deleted` | reference/getCategories |
| `GET` | `/items` | Productos → `products` (por `cloverId`) | `expand=categories,itemStock,taxRates,modifierGroups`; `id, name, price, sku, available, hidden, deleted, taxRates` | reference/getItems |
| `GET` | `/item_stocks` (o `expand=itemStock`) | 86 / stock → `products.stock_status` | `{ quantity, stockCount, stockAlertThreshold, modifiedTime }` + item `available` bool | reference/getItemStocks |
| `GET` | `/modifier_groups` | Grupos → `ingredients_groups` (por `cloverId`) | `expand=modifiers`; `id, name, minRequired, maxAllowed` | reference/getModifierGroups |
| `GET` | `/modifiers` (vía expand) | Opciones → `ingredients` (por `cloverId`) | `id, name, price` | reference/getModifiers |
| `GET` | `/employees` | Empleados → `employees` (por `(site_id, login=unhashedPin)`) | `id, name, nickname, customId, pin(hashed), unhashedPin, role(ADMIN\|MANAGER\|EMPLOYEE), roles[]` | reference/getEmployees |

### Pagos / tenders

| Método | Path | Propósito | Params clave | Escala |
|---|---|---|---|---|
| `GET` | `/payments` | Pull de pagos | `filter=modifiedTime>=…`, `expand=order,refunds`; voids/refunds/tips | centavos |
| `POST` | `/orders/{id}/payments` | Inyección de pago (outbound) | tender externo, `amount`, `tipAmount` | centavos |
| `GET` | `/tenders` | Listar tenders | tender externo "MCM" (id `4QPPVE0NFNBN4`) | — |
| `POST` | `/tenders` | Crear tender externo (idempotente; no requerido — ya existe) | — | — |

### Merchant / OAuth

| Método | Path | Propósito | Estado |
|---|---|---|---|
| `GET` | `/v3/merchants/{mId}` | Smoke / verificación de auth | verificado 200 |
| `POST` | `/oauth/token` (v2) | Intercambio de tokens (access/refresh) | **deferred** — no testeable sin app OAuth registrada; sandbox usa token estático |

---

## Hechos verificados en sandbox (`7ES0TRRRYJCY1`, "MCM Restaurant Test")

| # | Hecho | Fuente |
|---|---|---|
| 1 | `GET /v3/merchants/{mId}` = 200 en **ambos** hosts sandbox | Fase 0 |
| 2 | **15 tenders**, incluye tender externo **"MCM" `4QPPVE0NFNBN4`** (enabled, = `config.defaultTenderId`) y "External Payment" `83BVTM1R6W0GT` (`com.clover.tender.external_payment`) | Fase 0 / Slice A |
| 3 | Empleados con **`unhashedPin = null`** (1 empleado, role ADMIN) → link por PIN da 0; handler skip + evento `clover_employee_pin_unmatched` | Slice B |
| 4 | Items con `available` (bool) + `itemStock` (expand) → 86 round-trip verificado | Slice B |
| 5 | Catálogo: **20 categorías**, **114 items**, **90 ingredients**, **10 modifier_groups** — sync inicial `created`, re-run idempotente (0/0/skipped tras fix de precio en céntimos) | Slice B |
| 6 | **Órdenes core NO traen `table` ni `employee`** (keys: href,id,currency,externalReferenceId,paymentState,title,note,orderType,…,lineItems) → enrichment de mesa/empleado no factible desde Orders API (spike P1.5) | Slice E / BLOQUEOS |
| 7 | **`externalReferenceId` cap 12 chars** — ref más largo → HTTP 400 `Invoice ID cannot exceed 12 characters` | Slice D |
| 8 | **`bulk_line_items` requiere `price`** — `{item:{id}}` solo → 400 `Price must not be null` | Slice D |
| 9 | **`/modifications` NO dedupea** — doble-POST del mismo modifier → 2 modificaciones (P1.6 confirmado) | Slice E |
| 10 | **Refund vía API sobre tender externo offline → HTTP 405** (no refundable por API en sandbox) | Slice C/F |
| 11 | Lookup secundario por `externalReferenceId` **no adoptó** una orden recién creada (lag de indexado); el dedup primario por `clover_ticket_id` persistido es el robusto | Slice D |
| 12 | Clover **no recalcula `order.total`** al hacer `bulk_line_items` → hay que asentarlo con `POST /orders/:id {total}` (fix `total $0.00`, 2026-06-10) | clover-integration.md §1b |
