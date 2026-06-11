# Auditoría de concurrencia — sync Clover ↔ MCM ↔ Omnivore (2026-06-10)

**Sitio de referencia:** Pala Pizza (`48372619`). Flujos activos: Omnivore→MCM (sync órdenes),
MCM→Clover (push órdenes), Clover→MCM→Omnivore (pull de pagos + reenvío).
**Pregunta del usuario:** si corren 2 jobs de sync del mismo tipo a la vez, ¿hay protección contra
duplicados? **Método:** lectura del código vivo + índices/constraints reales de la DB Dev
(`blbelbdvykpvbeqbjqom`) + pruebas en vivo de cada RPC. Nada inventado; severidad honesta.

## Veredicto por escenario (verificado)

| Escenario | ¿Seguro? | Causa raíz / mecanismo (verificado) |
|---|---|---|
| Mismo job, 2 workers | ✅ SAFE | `claim_next_job` `FOR UPDATE SKIP LOCKED` + `locked_by` (002) |
| enqueue duplicado (mismo idempotency_key) | ✅ SAFE | UNIQUE `integration_jobs.idempotency_key` + `ON CONFLICT DO NOTHING` (live) |
| **2× sync de órdenes Omnivore→MCM** | ✅ SAFE | UNIQUE `orders_site_omnivore_pos_id_uniq (site_id,omnivore_pos_id)` + `.upsert(onConflict, ignoreDuplicates)` |
| **2× push de órdenes MCM→Clover** | ✅ SAFE | UNIQUE `orders_site_clover_pos_id_uniq (site_id,clover_pos_id)` + idempotency `clover_inject:{order}:{hash}` |
| **2× pull de pagos Clover** | ❌→✅ **(Fix 1)** | `payments` NO tenía UNIQUE en `(site_id,pos_id)` (solo índice no-unique) + `.insert()` plano → 2 inserts concurrentes ⇒ pagos duplicados ⇒ doble cargo a Omnivore. |
| 2× sync mismo (site,tipo) solapados | ⚠️→✅ **(Fix 2)** | scheduler bucketea por intervalo; sin gate. Un sync lento o "Probar ahora" + tick ⇒ 2 jobs concurrentes. |
| Manifest suplementario (2 reconcile) | ⚠️→✅ **(Fix 3)** | read-modify-write en JS sin lock ⇒ corrupción / doble-bill de ítem solapado. |
| Cursor de sync | ⚠️→✅ **(Fix 4)** | `complete_sync_schedule` `coalesce(p_cursor,last_cursor)` no monótono ⇒ regresión por run viejo. |

**Config REAL (sync_schedules, Pala):** `clover.fetch_payments` ACTIVO **@15s**, `clover.push_orders`
ACTIVO **@15s**, `omnivore.fetch_recent_orders` @60s; `fetch_open/closed_orders` disabled. El pull de
pagos (el flujo con el race) corre en vivo cada 15s con ventana de solape de 2min ⇒ el escenario no es
teórico.

**Severidad honesta:** el doble-pago (Fix 1) es de **alto impacto pero race LATENTE** (requiere solape
temporal real; secuencialmente el `clover_payment_map` ya deduplica). El manifest (Fix 3) es **gatillo
angosto** (2 adds post-pago concurrentes). Fix 2/4 son hardening/eficiencia: la corrección DE FONDO la
dan los constraints/RPC (Fix 1/3), que hacen los duplicados imposibles bajo CUALQUIER concurrencia.

## Fixes aplicados (Dev) + evidencia

### Fix 1 — pagos idempotentes (migración 016 + `upsert-payments.ts`)
- `CREATE UNIQUE INDEX payments_site_pos_id_uniq ON payments(site_id,pos_id)` **(NO-parcial)**. 0
  duplicados previos en Dev. Espejo de los índices de `orders`.
- El `.insert()` → `.upsert({...},{onConflict:'site_id,pos_id'})`. Dos pulls concurrentes convergen en
  UNA fila (mismo `id`) ⇒ un solo `pos_pay:omnivore:{id}` ⇒ una sola inyección a Omnivore.
- **Cobertura:** TODOS los caminos (scheduler, "Probar ahora", solape). Es la garantía de fondo.
- **HOTFIX 2026-06-10:** el índice se creó primero PARCIAL (`WHERE pos_id IS NOT NULL`), pero
  `.upsert(onConflict)` NO matchea índices parciales (Postgres `42P10`) → el pull de pagos falló en
  cada corrida (pagos sin registrar). Corregido a **no-parcial** (los NULL siguen permitidos). Ver
  `reference_postgrest_upsert_partial_index`. **En prod aplicar directamente la versión no-parcial.**

### Fix 2 — gate de serialización (migración 017)
- `claim_due_schedules` **y** `trigger_sync_now` no encolan si ya hay un job activo del mismo
  `(site_id,integration,sync_type)` en `('pending','running','retrying')`. `trigger_sync_now` devuelve
  el job activo existente.
- **Evidencia live:** 2 llamadas seguidas a `trigger_sync_now(48372619,'clover','fetch_payments')`
  devolvieron el **mismo** `job_id` (no se duplicó).

### Fix 3 — bookkeeping del manifest suplementario atómico (migración 018 + `supplemental.ts`)
- RPC `claim_clover_supplement(...)` computa el delta bajo `SELECT ... FOR UPDATE` de la fila `orders`
  y appendea la entrada (idempotente por `delta_signature`). `set_clover_supplement_clover_id(...)`
  persiste el clover id atómicamente. `handlePaidPrimaryDelta` delega en la RPC.
- **Evidencia live (orden 10195, snapshot+restore):**
  1. delta nuevo `{Burger,Fries}` vs seed `{Burger}` → `has_delta:true, delta_keys:{Fries}`.
  2. **mismo delta otra vez → `has_delta:false`** (la 2ª reconcile ve el suplemento de la 1ª → SIN
     doble-bill). ← prueba clave de atomicidad.
  3. add incremental `Taco` → `delta_keys:{Taco}`.
  4. remoción → `has_removal:true, has_delta:false` (needs_review, diferido).
  La orden 10195 se restauró (`additional_properties - 'clover_supplemental'`).

### Fix 4 — cursor monótono (migración 017)
- `complete_sync_schedule` avanza `last_cursor` solo hacia adelante para cursores numéricos.
- **Evidencia live:** cursor menor no regresa (`greatest`), cursor mayor avanza.

## Tests + deploy
- `tsc 0`; **104/104** unit tests verdes (el único suite que falla, `circuit-breaker`, es pre-existente
  por `LOG_LEVEL` de entorno — no tocado). Cobertura nueva: `clover-pull` (upsert idempotente,
  onConflict), `clover-supplemental` (RPC: delta/no-delta/removal + create handler vía RPC).
- Migraciones 016/017/018 aplicadas a Dev. Workers `pos_injection` (3011) + `pos_sync` (3010)
  reiniciados con el código nuevo (sanos). Sin cambios de edge.

## Salvaguardas que YA funcionaban (no se tocaron)
`claim_next_job` SKIP LOCKED; idempotency de `enqueue_job`; leader-election del scheduler
(`RUN_SCHEDULER=true` solo en `pos_sync`); guard `orderHasAppliedPayment` (cross-sync no reabre orden
pagada). Las ÓRDENES ya eran a prueba de duplicados (índices UNIQUE).

## Deploy a PRODUCCIÓN (pendiente — documentado, no ejecutado)
1. **Dedup-check de pagos antes de 016:** `select site_id,pos_id,count(*) from payments where pos_id is
   not null group by 1,2 having count(*)>1;` → debe dar 0. Si hay dups, consolidarlos primero.
2. **016 en prod con `CREATE UNIQUE INDEX CONCURRENTLY`** (fuera de transacción).
3. Aplicar **017** y **018**.
4. Desplegar el código del worker (`upsert-payments.ts`, `supplemental.ts`, `create-supplemental-order.ts`)
   y reiniciar `pos_injection` + `pos_sync`.
5. Confirmar `RUN_SCHEDULER=true` SOLO en `pos_sync`.

## Diferido (con justificación)
- Límite de concurrencia por-sitio en `integration_concurrency_limits` (el gate ya serializa por tipo).
- Advisory locks por-handler (las garantías DB/RPC cubren las races; el usuario eligió "Completo" sin
  los locks extra).
- Remoción post-pago (delta negativo) = refund sobre orden bloqueada → se hace VISIBLE
  (`CLOVER_SUPPLEMENTAL_NEGATIVE_DELTA`), no se billa negativo.
- Alerta de pagos huérfanos (pago > watermark sin orden) — observabilidad, follow-up.
