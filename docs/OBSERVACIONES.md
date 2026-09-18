# Observaciones — cosas vistas y NO tocadas

Hallazgos que aparecieron trabajando en otra cosa y que se dejaron fuera de alcance a propósito.
Cada uno con su evidencia, para que el siguiente no tenga que volver a medirlo.

---

## 2026-09-11 · Sprint «carril de cierres por `closed_at`»

### 1. La ventana auto-expansible que no se hizo (la de fondo)

La ventana del carril de cierres es **el único mecanismo de recuperación que existe**: no hay
backfill, y la reconciliación inversa se propuso (WS-5/F16, `audits/2026-06-09`) y no se implementó.
Al bajarla a 2 h, un apagón del worker de más de 2 h pierde esos cierres de forma permanente.

Y los apagones existen — medido sobre `integration_jobs`, 30 días, huecos entre corridas **exitosas**
de `omnivore.fetch_closed_orders`:

| Cuándo | Sites | Sin sincronizar |
|---|---|---|
| 31-ago 05:00→21:50 | 48372619 + 1173690 + 51021421 (**simultáneo al segundo**) | **16,8 h** |
| 27-ago 04:33→14:53 | 48372619 + 51021421 | 10,3 h |
| 17-ago 20:31→09:04 | 51021421 | 12,5 h |
| 11-sep 00:59→16:49 | 70080000 | 15,8 h |

**16 huecos >2 h en 30 días, 9 de ellos >5 h.** Los simultáneos al segundo son apagones de
infraestructura, no del POS. Hasta ahora los absorbía la ventana de 24 h sobre `opened_at`, por
accidente de diseño.

**El arreglo, si vuelve a doler:** hacer la ventana `max(2h, ahora − last_cursor) + solape`, con tope
~26 h. La tubería ya está puesta y sin usar: `sync_schedules.last_cursor` llega al handler en
`stepInput.cursor` (`fetch-closed-orders.ts:13`) y se tira — al terminar escribe `p_cursor: null`
(`:72`). El patrón está implementado y probado en `clover/sync/fetch-payments.ts:18,34-55`
(watermark + `OVERLAP_MS` de 2 min + clamp anti-futuro). Ojo al hacerlo: `complete_sync_schedule`
guarda el mayor para cursores numéricos (`migrations/033_sync_health_last_success.sql:47-53`), lo que
protege el watermark contra retrocesos si se guarda el epoch en segundos.

### 2. `payments` puede duplicarse (no `orders`) — RESUELTO 2026-09-18

> **Resuelto:** el escritor se retiró en el motor y en el edge (decisión del dueño: en `payments` solo va lo que MCM cobró) y el
> histórico se respaldó y borró. Ver `docs/omnivore-integration.md` («Los cobros hechos en el terminal de Aloha…»). Lo de abajo
> queda como diagnóstico.

`recordExternalOmnivorePaymentIfNeeded` (`upsert-orders.ts:80-103`) era un **check-then-insert** sin
llave única que lo cubra: el único índice de pagos es `payments (site_id, pos_id)`
(`migrations/016_payments_pos_id_unique.sql:31-33`) y **este insert no setea `pos_id`** — sólo
`reference: omnivore:<pos_id>`.

Y los dos carriles **no están serializados entre sí**: el gate de `claim_due_schedules` filtra por
`r.job_type = v_schedule.sync_type` (`033:82-90`), así que `fetch_open_orders` (20 s) y
`fetch_closed_orders` (90 s) son `job_type` distintos y pueden correr a la vez llamando ambos a
`upsertOmnivoreOrders`. Un ticket con `paid>0 && due==0` visto simultáneamente por los dos puede
generar **dos filas `payments` para el mismo dinero**. Es la misma clase de bug que la migración 016
arregló para Clover. Sin medir cuántos hay.

### 3. Comentarios que mienten

- `fetch-recent-orders.ts:37` dice «ventana rodante 36h»; el código comparte la de 24 h desde julio.
- `clover/sync/fetch-closed-orders.ts:15` dice «Runs every 2min»; la fila real es de **300 s**
  (`migrations/028_clover_catalog_schedules.sql:55`, y así desde la 007).

### 4. Re-aplicar `migrations/028` borraría los carriles de Omnivore

La rama omnivore de `ensure_sync_schedules` en este repo **sigue escribiendo `fetch_recent_orders`
60 s** (`028_clover_catalog_schedules.sql:78`). Los dos carriles (`fetch_open_orders` 20 s /
`fetch_closed_orders` 90 s) se inyectan por **patch programático** sobre la definición viva desde
`mcm-edge-functions/supabase/migrations/20260727120000_omnivore_split_order_sync.sql:60-105`.
O sea: la DB va por delante del repo, y re-aplicar la 028 se lleva los dos carriles por delante.

### 5. Código muerto y ruido de API

- `order-mapper.ts:6` — `PR_TZ_OFFSET_MS`, **0 usos** en todo `src/`. Resto del diseño anterior
  («hoy calendario PR»). Compila porque `tsconfig.json` tiene `noUnusedLocals: false`.
- `src/observability/events.ts:10-11` declara `SYNC_COMPLETED` / `SYNC_FAILED`, pero el objeto
  `Events` **no se importa en ningún sitio** y esos eventos nunca se emiten — aunque `README.md:134`
  los documenta como si existieran. En PostHog sólo hay eventos a nivel job/step.
