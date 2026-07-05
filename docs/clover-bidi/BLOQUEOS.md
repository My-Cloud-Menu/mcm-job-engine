# BLOQUEOS y deferred — Clover ↔ MCM bidireccional

> Se documenta aquí todo lo que quede `⚠️ NO VERIFICADO`, requiera una decisión externa, o no sea testeable esta noche.
> Con la decisión #3 del usuario (empujar todo lo posible), cada ítem se **intenta**; solo aterriza aquí si el entorno demuestra que no es fiable.

## Abiertos

- _(ninguno al cierre de Fase 0)_

## Condiciones a resolver / limitaciones conocidas

- **Aislamiento cross-merchant a nivel API de Clover:** solo hay **1 merchant sandbox** (`7ES0TRRRYJCY1`, "MCM Restaurant Test"). No se puede probar que el token de un merchant no lea datos de otro en la capa API. Se cubre aislamiento **row/control-plane** (site A Clover ON vs site B control sin Clover + prueba negativa con credencial inválida). **Follow-up:** proveer un 2º merchant sandbox.
- **OAuth expiring tokens:** el sandbox usa **token estático** (merchant API token). El intercambio OAuth real (access/refresh) no es testeable sin una app OAuth de Clover registrada. Se construye diseño + scaffold aditivo; el flujo live queda documentado como no verificado.

## Follow-ups de Slice B (catálogo)

- **Empleados sin PIN:** el merchant sandbox `7ES0TRRRYJCY1` devuelve `unhashedPin=null` (1 empleado, role ADMIN). El link `(site_id, login=PIN)` da 0 → handler correcto (skip + evento `clover_employee_pin_unmatched`), pero la verificación live del match por PIN queda pendiente de un merchant con passcode-login habilitado + token con visibilidad de PIN.
- **`fetch_tables` (spike P1.5 RESUELTO):** las órdenes core de Clover **NO traen `table` ni `employee`** (keys: href,id,currency,externalReferenceId,paymentState,title,note,orderType,...,lineItems). ⇒ El order-enrichment de mesa **no es factible** desde el order object. `fetch_tables` queda floor-layout-only/deferred (Clover Tables vive en la app "Tables" aparte, no en Orders API). El enrichment de empleado en órdenes también es moot para este merchant.
- **Modificadores — archive:** hoy create/update/skip idempotente; el soft-archive de ingredients/groups ausentes es follow-up (menor riesgo que productos).
- **Modificadores — min/max:** mapeados desde `minRequired/maxAllowed` (0 si ausentes en el group object). Verificar nombres de campo si un merchant define required-modifiers.
- **Paginación >6000 elementos:** offset con cap+log (`clover_catalog_pagination_capped`). Follow-up: cursor por `modifiedTime` para catálogos enormes (sandbox 114 << cap).

## Hallazgos para verificar en el edge de producción (Slice D)

- **`externalReferenceId` cap 12 chars:** verificar que `buildCloverInjectionPayload` (edge) derive un Invoice ID ≤12 chars del `order.id` (ids grandes deben acortarse). Un ref largo → HTTP 400. (No se tocó el edge.)
- **Refund/void live:** el tender externo *offline* del sandbox devuelve 405 a refunds por API. Verificación live de refund/void requiere un pago con tarjeta o refund vía Merchant Dashboard. Lógica de reflejo cubierta por `clover-pull.test.ts`.
- **Lookup secundario `externalReferenceId`:** en sandbox no adoptó una orden recién creada (lag de indexado). El dedup primario (`clover_ticket_id` persistido) es el robusto y el usado en producción.

## Hallazgos de la revisión de robustez (2026-07-02)

- **[SEGURIDAD, PRE-EXISTENTE — para Carlos]** `ensure_sync_schedules(site_id,...)` y `trigger_sync_now(site_id,...)` son `SECURITY DEFINER` con `GRANT EXECUTE ... authenticated` y **sin check `has_location_access`** → un usuario autenticado de cualquier tenant podría provisionar/disparar syncs para **cualquier `site_id`** (escritura cross-tenant en `sync_schedules` / encolar jobs). Viene de la migración 021; mi mig 028 la recreó byte-for-byte (no introdujo ni corrigió). No se corrigió esta noche por ser función compartida de producción (dashboard + Omnivore la usan) y requerir entender el contexto de auth del caller. **Recomendación:** añadir `if not has_location_access(p_site_id) then raise ...` en una revisión de seguridad dedicada.
- **Modificadores sin soft-archive:** un modifier group/modifier borrado en Clover permanece en MCM (create/update/skip idempotente hoy). Follow-up: añadir soft-archive con el mismo floor guard (`archiveIsSafe`).
- **Order-mapper — re-sync único al desplegar:** poblar `attributes`/`product_id` cambia el output del mapper → el primer pull tras el deploy re-actualiza las órdenes abiertas existentes una vez (bounded, esperado; sin churn después).
- **Productos sin categoría:** 10/114 items del sandbox no tienen categoría en Clover → no aparecen en el menú por-categoría del POS (inherente al modelo de menú, no es bug). Si se requiere, crear una categoría "Sin categoría" o un item de catálogo por `products_id`.
- **>1000 items por catálogo:** paginación por offset con cap+log; el floor guard evita el borrado, pero un catálogo enorme necesita cursor por `modifiedTime` (follow-up).

## Limitaciones de Clover (no son bugs de MCM)

- **Emoji / caracteres astrales (4-byte UTF-8) en nombres:** Clover los almacena como "?" (p.ej. un producto "Tacos 🌮" → "Tacos ?"). MCM envía el nombre verbatim; la pérdida es del lado de Clover. Acentos, «», comillas, `<b>`, `&`, `%` sí se preservan. Si importa, sanitizar/mapear astral chars antes de enviar (lossy).
- **`bulk_line_items` cap 100/request:** manejado con chunking en `reconcile_items` (fix HIGH de la 3ª ronda). El cap por orden es 2500 (guard existente a 3000).

## Menores documentados (2ª ronda de pruebas)

- **Cursor 6000-boundary (LOW):** un catálogo con exactamente 6000 items no-borrados hace que la paginación por cursor devuelva `complete:false` en el sweep completo → ese sweep no ejecuta el soft-archive (conservador — nunca borra de más, solo pospone el archive al siguiente sweep). Follow-up trivial: subir `MAX_PAGES` o hacer una página extra de confirmación.
- **`bulk_line_items` no garantiza orden de respuesta** (hallazgo verificado): la correlación línea↔modificador se hace por `(name, price)`, no por índice. Líneas idénticas (mismo name+price) con modificadores distintos se asignan posicionalmente dentro de la misma clave (edge de un edge, documentado).
- **Modificadores nativos permanentes (400):** un `modifier.id` que no es un modificador de catálogo válido da 400 → se deja best-effort (un retry no lo arreglaría); no bloquea la orden ni marca error. Los fallos transitorios sí reintentan.

## Completados (2ª ronda de follow-ups #1–#4)

- ✅ **Soft-archive de modificadores** — implementado con floor-guard; verificado (grupo fantasma → draft+cloverArchived).
- ✅ **Productos sin categoría en el menú POS** — el catálogo auto los añade por `products_id`; verificado `get-menus` 104→114.
- ✅ **Paginación >1000 (cursor)** — implementada por `id` (`orderBy=id&filter=id>X`); verificada con 114 items + unit tests. Live >1000 aún pendiente de un merchant grande (sandbox=114).
- ✅ **Modificadores nativos outbound** — implementados (flag `cloverNativeModifiers` OFF) + idempotentes por el DELETE+RECREATE; verificado (adjunto + sin acumulación).

## Resueltos

- **Discrepancia de host `sandbox.dev` vs `apisandbox.dev`** (Fase 0): ✅ ambos autentican (200); se usa el configurado `sandbox.dev.clover.com`. Sin bug.
- **Tender externo "MCM"** (Slice A): ✅ ya existe (`4QPPVE0NFNBN4`, enabled) y es el `defaultTenderId`. No hay que crearlo.
