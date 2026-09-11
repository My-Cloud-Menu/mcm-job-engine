# mcm-job-engine — Context for Claude

## What this project is

Distributed job/worker engine for **My Cloud Menu** (restaurant POS SaaS). Handles POS order injection (Omnivore, Clover), periodic order sync, SMS/email notifications, and outgoing webhooks. No external queue broker — Postgres does everything via `pg_notify`, advisory locks, and `pg_cron`.

**Owner:** Carlos Santos — `csantos@mycloudmenu.com`  
**Deploy target:** Hostinger Easy Panel (4 Docker containers) + Supabase Cloud  
**Stack:** TypeScript, Node.js, Express, Supabase/PostgreSQL, Vitest

---

## Architecture in one picture

```
                      Supabase Postgres
                 ┌────────────────────────────┐
                 │  integration_jobs           │
                 │  job_steps                  │
                 │  job_step_attempts          │
                 │  dead_letter_jobs           │
                 │  sync_schedules             │
                 │  alerts_outbox              │
                 │  integration_concurrency_   │
                 │    limits                   │
                 └────────────┬───────────────┘
                              │ pg_notify / poll
          ┌───────────────────┼───────────────────┐
          │                   │                   │
  worker-pos-injection  worker-pos-sync    worker-notifications
                        + scheduler        worker-webhooks
                        + alert dispatcher
          │                   │                   │
  Omnivore / Clover    Omnivore / Clover    Twilio / SendGrid
```

**4 queues:** `pos_injection`, `pos_sync`, `notifications`, `webhooks`  
All 4 workers run the same Docker image — differentiated by `WORKER_QUEUE_NAME` env var.

---

## Project structure

```
src/
  index.ts                 — entry point: worker loop + graceful shutdown
  config.ts                — all env vars in one place
  server.ts                — Express: GET /health, GET /
  core/
    types.ts               — Job, JobStep, Handler, HandlerError interfaces
    executor.ts            — job execution pipeline (steps, retry, heartbeat)
    claim.ts               — claimNextJob() RPC wrapper
    circuit-breaker.ts     — in-memory state machine per integration
    error-classifier.ts    — retryable vs dead-letter classification
    backoff.ts             — exponential backoff calculation
  handlers/
    registry.ts            — Map<"integration.step_name", Handler>
    omnivore/
      client.ts            — Axios instance with Omnivore auth
      inject/              — create-order, add-items, create-payment, payment
      sync/                — fetch-open-orders (20s, eq(open,true))
                             fetch-closed-orders (90s, closed_at 2h + open → detecta cierres)
                             fetch-recent-orders (retirado: schedule disabled, handler vivo
                             para jobs en vuelo y rollback)
    clover/                — same structure as omnivore
    twilio/send-sms.ts
    sendgrid/send-email.ts
  enqueue/                 — public API: enqueueOrderInjection, enqueueSms, etc.
  scheduler/
    index.ts               — polls claim_due_schedules() every 5s
    leader-lock.ts         — advisory lock for singleton scheduler
  observability/
    posthog.ts             — event tracking
    alerts/dispatcher.ts   — drains alerts_outbox via Resend
  lib/
    pg-pool.ts             — pg connection pool (for LISTEN/NOTIFY)
    pg-listener.ts         — PostgreSQL LISTEN/NOTIFY wrapper
    logger.ts              — Pino structured logger
    credentials.ts         — fetches per-site API credentials from DB
migrations/
  001_jobs_schema.sql      — enums, tables, indexes, RLS, NOTIFY triggers
  002_jobs_functions.sql   — all stored procedures (enqueue, claim, complete, etc.)
  003_cron.sql             — pg_cron: recover_stuck_jobs (1 min), cleanup (daily)
  004_views.sql            — monitoring views
  005_seed_limits.sql      — default concurrency limits
tests/unit/                — Vitest: backoff, circuit-breaker, error-classifier, sanitization
```

---

## How a job flows end to end

1. **Enqueue** — caller invokes `enqueue_job(...)` RPC. `ON CONFLICT (idempotency_key) DO NOTHING` prevents duplicates. Postgres trigger fires `pg_notify('jobs_<queue>', job_id)`.

2. **Claim** — `claim_next_job()` uses `SELECT ... FOR UPDATE SKIP LOCKED`. Multiple workers compete safely; each gets a different row. Job becomes `running` with `locked_until = now() + 180s`.

3. **Execute** — `executor.ts` iterates steps in order:
   - Looks up handler via `registry.get("integration.step_name")`
   - Checks circuit breaker — if open, fails fast
   - Calls `heartbeat_job()` every 60s to extend `locked_until`
   - On success: `complete_step()` saves output into `integration_jobs.context` under the step name key (so next steps can read `context.create_order.order_id`)
   - On error: classifies as retryable → `fail_step(id, error, next_retry_at)` or dead-letter → `fail_step(id, error, null)`

4. **Retry** — job moves to `retrying` state, `scheduled_for` set to backoff timestamp, re-queued automatically.

5. **Dead letter** — job moves to `dead_letter`. Row inserted in `dead_letter_jobs`. Trigger fires email alert via Resend (deduplicated within 5 min window).

6. **Recovery** — `pg_cron` runs `recover_stuck_jobs()` every minute. Any `running` job with `locked_until < now()` is reset to `retrying`. Max zombie time ≈ 180s lock + 1 min cron = ~4 min.

---

## Key stored procedures (migrations/002_jobs_functions.sql)

| Function | Purpose |
|---|---|
| `enqueue_job(...)` | Insert job+steps, idempotent via `ON CONFLICT` |
| `claim_next_job(worker_id, queue, lock_seconds, integrations[])` | Atomic claim with concurrency limit checks |
| `heartbeat_job(job_id, worker_id, extend_seconds)` | Extend lock while job is running |
| `complete_step(step_id, output)` | Mark step done, merge output into job context |
| `fail_step(step_id, error, next_retry_at)` | Schedule retry or dead-letter |
| `release_job_lock(job_id)` | Return job to pending (used on graceful shutdown) |
| `recover_stuck_jobs()` | Requeue locked jobs with expired `locked_until` |
| `retry_dead_letter_job(job_id)` | Manual re-queue of a dead-letter job |
| `bulk_retry_dead_letters({integration?, site_id?, since?})` | Batch re-queue |
| `claim_due_schedules(limit)` | Scheduler: claim + enqueue overdue syncs |
| `enqueue_alert(dedupe_key, severity, ...)` | Add to alerts_outbox with 5-min dedup |

---

## Handler interface

```typescript
// src/core/types.ts
type Handler = (input: HandlerInput) => Promise<Record<string, unknown>>;

interface HandlerInput {
  stepInput:  Record<string, unknown>;  // this step's input from job_steps.input
  jobPayload: Record<string, unknown>;  // original job payload
  context:    Record<string, unknown>;  // accumulated outputs from previous steps
  job:        Job;
  step:       JobStep;
}
```

To register a handler:
```typescript
// Each file self-registers at import time
import { registerHandler } from '../../registry';
registerHandler('omnivore', 'create_order', async ({ stepInput, context }) => {
  // ... call external API
  return { order_id: '...' };  // stored in context.create_order.order_id
});
```

---

## Adding a new integration

1. `src/handlers/{name}/client.ts` — Axios instance with auth headers
2. `src/handlers/{name}/inject/*.ts` — one file per step, each calls `registerHandler()`
3. `src/handlers/{name}/sync/*.ts` — if the integration supports sync
4. Import all files in `src/handlers/registry.ts`
5. Add concurrency limit row to `migrations/005_seed_limits.sql` (or INSERT directly)
6. Add integration to `WORKER_INTEGRATIONS` env var on relevant worker service

---

## Running locally (Supabase CLI)

```bash
# Prerequisites: Docker + Supabase CLI installed (supabase v2.98.1+)

# 1. Start local Supabase stack
supabase start
# Prints: API URL, DB URL, service_role key

# 2. Apply migrations
psql "postgresql://postgres:postgres@localhost:54322/postgres" \
  -f migrations/001_jobs_schema.sql \
  -f migrations/002_jobs_functions.sql \
  -f migrations/003_cron.sql \
  -f migrations/004_views.sql \
  -f migrations/005_seed_limits.sql

# 3. Configure env
cp .env.example .env
# Set SUPABASE_URL=http://localhost:54321
# Set SUPABASE_SERVICE_ROLE_KEY=<from supabase start output>
# Set DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
# Set WORKER_QUEUE_NAME=pos_injection

# 4. Start a worker
npm run dev

# 5. Health check
curl http://localhost:3000/health

# 6. Run unit tests
npm test

# 7. Stop local stack
supabase stop
```

**Note:** The `sites` table is referenced by FK in `integration_jobs`. If it doesn't exist locally, add `CREATE TABLE sites (id bigint primary key);` before migration 001 or mock it in test data.

---

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SUPABASE_URL` | ✓ | — | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | — | Service role JWT |
| `DATABASE_URL` | ✓ | — | Direct Postgres connection for pg pool |
| `WORKER_QUEUE_NAME` | ✓ | — | `pos_injection` \| `pos_sync` \| `notifications` \| `webhooks` |
| `WORKER_INTEGRATIONS` | — | all | Comma-separated filter (e.g., `omnivore,clover`) |
| `WORKER_MAX_CONCURRENT_JOBS` | — | `10` | Parallel jobs per worker process |
| `WORKER_POLL_INTERVAL_MS` | — | `2000` | Polling fallback (NOTIFY is primary) |
| `WORKER_LOCK_DURATION_SECONDS` | — | `180` | Job lease duration |
| `WORKER_HEARTBEAT_INTERVAL_MS` | — | `60000` | How often heartbeat extends lease |
| `RUN_SCHEDULER` | — | `false` | Set `true` on exactly ONE replica |
| `RUN_ALERT_DISPATCHER` | — | `false` | Set `true` on exactly ONE replica |
| `CB_ENABLED` | — | `false` | **Breaker apagado por defecto** (2026-08-06). Las tres de abajo sólo aplican con `true` |
| `CB_THRESHOLD` | — | `10` | Failures in window before breaker opens |
| `CB_WINDOW_SECONDS` | — | `60` | Circuit breaker measurement window |
| `CB_COOLDOWN_SECONDS` | — | `300` | Time in open state before half-open |
| `POSTHOG_API_KEY` | — | — | Optional analytics |
| `RESEND_API_KEY` | — | — | Required for operational email alerts |
| `ALERT_FROM_EMAIL` | — | `alerts@visionarysoft.com` | |
| `ALERT_EMAILS` | — | `csantos@mycloudmenu.com` | Comma-separated recipients |
| `ALERT_RATE_LIMIT_PER_HOUR` | — | `20` | Cupo horario de `warning`/`info` por destinatario |
| `ALERT_RATE_LIMIT_CRITICAL_PER_HOUR` | — | `60` | Carril propio de `critical` — no lo consume el ruido |
| `ALERT_RATE_LIMIT_PER_SITE_PER_HOUR` | — | `6` | Techo por site para `warning`/`info` |

---

## Production deployment (Easy Panel)

4 services, same Docker image, different env vars:

| Service | `WORKER_QUEUE_NAME` | `MAX_CONCURRENT` | `RUN_SCHEDULER` | `RUN_ALERT_DISPATCHER` |
|---|---|---|---|---|
| worker-pos-injection | `pos_injection` | `20` | `false` | `false` |
| worker-pos-sync | `pos_sync` | `30` | `true` | `true` |
| worker-notifications | `notifications` | `30` | `false` | `false` |
| worker-webhooks | `webhooks` | `10` | `false` | `false` |

Healthcheck: `GET /health` → `200` OK / `503` during shutdown.

---

## Monitoring SQL queries

```sql
-- Queue depths
SELECT queue_name, count(*) FROM integration_jobs
WHERE status IN ('pending','retrying') GROUP BY queue_name;

-- Dead letters last 24h
SELECT * FROM jobs_attention_needed;

-- Per-site health
SELECT * FROM jobs_site_health ORDER BY failed_24h DESC;

-- Sync schedule health
SELECT * FROM sync_status WHERE health != 'healthy';

-- Stuck running jobs (should be empty — reaper runs every minute)
SELECT id, site_id, integration, locked_until FROM integration_jobs
WHERE status = 'running' AND locked_until < now();

-- Recent alerts
SELECT * FROM alerts_recent_view;
```

---

## Critical things to know

**Idempotency toward external POS APIs is the #1 risk.** `enqueue_job` is idempotent (DB level), and each step has an `idempotency_key` field — but handlers must actively use it when calling Omnivore/Clover. If a step succeeds at the API but fails before `complete_step()` is committed, the retry will re-call the POS. Verify each inject handler uses idempotency headers or does check-then-create.

**El circuit breaker está APAGADO (`CB_ENABLED=false`, default desde 2026-08-06).** La regla de negocio es: *el sync siempre corre*. Si una integración se cae 3 horas y vuelve, el sync la retoma solo, sin cooldown ni intervención. Encendido no cumplía eso: su llave es `(integration, queue)` **sin site**, así que un solo POS caído —incluido un sandbox de demo— bloqueaba el sync de todos los demás sites de esa integración. Incidente del 2026-08-06: Arena Medalla (site vivo, POS sano) estuvo 3h11m sin sincronizar en pleno servicio porque las locations muertas de certificación abrían el breaker compartido. Antes de volver a encenderlo hay que meter el `site_id` en la llave.

**`sync_status.health` mide ÉXITO, no actividad del scheduler** (migración 033). Hasta entonces respondía "¿pasó el scheduler por aquí?": `claim_due_schedules` avanzaba `last_run_at` aunque el gate de serialización decidiera no encolar nada, y `consecutive_failures` sólo sube desde el handler —que con el breaker abierto nunca corría—, así que un apagón de 3h se veía `healthy`. Ahora `sync_schedules.last_success_at` lo escribe `complete_sync_schedule` y `stale` se calcula contra él, con un piso de 5 min para no dar falsos positivos en los syncs de 20s. `last_run_at` pasó a significar "último encolado real".

**Las alertas no se tapan entre sí** (migración 034). El cupo era uno solo (20/h por destinatario contando todo) y `processAlert` suprimía sin mirar severidad: un `critical` se callaba igual que un `info`, y lo callaba el ruido de otro site. Ahora `critical` tiene carril propio, `warning`/`info` comparten el global más un techo por site, y `enqueue_alert` aplica un cool-down por `dedupe_key` (critical 5 min · warning 15 · info 30) agrupando en la fila ya enviada en vez de mandar otro email.

**Un schedule en `failing` NO es un punto muerto** (migración 032). `fail_sync_schedule` marca `failing` a los 5 fallos seguidos, pero `claim_due_schedules` lo sigue tomando con la cadencia atenuada a mínimo 5 min; al primer éxito `complete_sync_schedule` lo devuelve a `active` con la cadencia normal. Antes de 032, `claim_due_schedules` exigía `status='active'` y un schedule que fallaba 5 veces no volvía nunca — había 8 syncs de Clover muertos desde hacía 17 días sin que nadie lo notara. `paused` y `disabled` sí siguen fuera: esos son apagados intencionales.

**`RUN_SCHEDULER=true` and `RUN_ALERT_DISPATCHER=true` must be set on exactly one service.** Advisory lock (`LEADER_LOCK_KEY = 4815162342`) in `src/config.ts` prevents double-running if misconfigured, but the lock releases on crash — a second replica would then become leader. By convention only `worker-pos-sync` has these flags.

**`pg_cron` requires the extension enabled in Supabase Dashboard** → Database → Extensions → `pg_cron`, before running `migrations/003_cron.sql`. It does NOT run in local Supabase CLI by default — you'll need to manually call `SELECT recover_stuck_jobs()` in local testing.

---

## npm scripts

```bash
npm run dev       # tsx watch — hot reload during development
npm run build     # tsc → dist/
npm start         # node dist/index.js
npm test          # vitest run (unit tests only)
npm run test:watch
```
