# mcm-job-engine

Distributed job/worker engine for **My Cloud Menu**. Handles POS order injection (Omnivore, Clover), periodic order sync, SMS/email notifications, and outgoing webhooks — all backed by Supabase Postgres, with no external queue brokers.

Every job belongs to a `site_id`, executes as an ordered sequence of steps, retries with queue-specific backoff, and moves to a dead-letter queue when exhausted. Circuit breakers protect external APIs. PostHog tracks lifecycle events. Resend delivers operational alerts with 5-minute deduplication.

## Architecture

```
                        Supabase Postgres
                       ┌────────────────────────────────────────────┐
                       │  integration_jobs   job_steps              │
                       │  job_step_attempts  dead_letter_jobs        │
                       │  sync_schedules     alerts_outbox           │
                       │  integration_concurrency_limits             │
                       └────────────────┬───────────────────────────┘
                                        │  pg_notify / poll
              ┌─────────────────────────┼──────────────────────────┐
              │                         │                           │
     ┌────────▼──────┐       ┌──────────▼──────┐       ┌───────────▼──────┐
     │ worker-pos-   │       │ worker-pos-sync  │       │ worker-          │
     │ injection     │       │ + scheduler      │       │ notifications    │
     │               │       │ + alert disp.    │       │                  │
     └───────────────┘       └─────────────────┘       └──────────────────┘
              │                         │                           │
     ┌────────▼──────┐       ┌──────────▼──────┐       ┌───────────▼──────┐
     │ worker-       │       │ Omnivore API     │       │ Twilio / SendGrid│
     │ webhooks      │       │ Clover API       │       │                  │
     └───────────────┘       └─────────────────┘       └──────────────────┘
```

- **4 worker containers** — one per queue type, all running the same image
- **Scheduler** — one leader (advisory lock) claims due sync schedules every 5s
- **Alert dispatcher** — one instance drains `alerts_outbox` via Resend
- **LISTEN/NOTIFY** — workers wake instantly when a new job enters their queue
- **pg_cron** — recovers stuck jobs every minute; cleans up old data nightly

## Migrations

Run in strict order against your Supabase project:

```sql
-- 1. Schema (enums, tables, RLS, triggers)
\i migrations/001_jobs_schema.sql

-- 2. Functions (enqueue_job, claim_next_job, complete_step, fail_step, ...)
\i migrations/002_jobs_functions.sql

-- 3. pg_cron jobs (requires pg_cron extension enabled in Supabase dashboard)
\i migrations/003_cron.sql

-- 4. Monitoring views
\i migrations/004_views.sql

-- 5. Seed default concurrency limits
\i migrations/005_seed_limits.sql
```

> **Note:** `003_cron.sql` requires the `pg_cron` extension. Enable it in  
> Supabase Dashboard → Database → Extensions → `pg_cron`.

## Running locally

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL

# 3. Start a single worker (pos_injection queue)
WORKER_QUEUE_NAME=pos_injection npm run dev

# Run tests
npm test
```

## Deploy on Hostinger Easy Panel

### One-time setup

1. Push this repo to GitHub.
2. In Easy Panel, create **4 services** pointing to the same repo/image, named:
   - `worker-pos-injection`
   - `worker-pos-sync`
   - `worker-notifications`
   - `worker-webhooks`

### Shared environment variables (set on all services)

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=
POSTHOG_API_KEY=
RESEND_API_KEY=
ALERT_FROM_EMAIL=alerts@visionarysoft.com
ALERT_EMAILS=csantos@mycloudmenu.com
LOG_LEVEL=info
NODE_ENV=production
```

### Per-service environment variables

| Service | `WORKER_QUEUE_NAME` | `WORKER_MAX_CONCURRENT_JOBS` | `RUN_SCHEDULER` | `RUN_ALERT_DISPATCHER` |
|---------|--------------------|-----------------------------|-----------------|------------------------|
| worker-pos-injection | `pos_injection` | `20` | `false` | `false` |
| worker-pos-sync | `pos_sync` | `30` | **`true`** | **`true`** |
| worker-notifications | `notifications` | `30` | `false` | `false` |
| worker-webhooks | `webhooks` | `10` | `false` | `false` |

> If you scale `worker-pos-sync` to multiple replicas, the pg advisory lock guarantees only one instance runs the scheduler and alert dispatcher.

### Healthcheck

Configure in Easy Panel: `GET /health` — returns `200` when running, `503` during graceful shutdown.

## Configure PostHog

1. Create a project at [posthog.com](https://posthog.com).
2. Copy the **Project API Key** → set `POSTHOG_API_KEY` in your env.
3. (Optional) Self-host: set `POSTHOG_HOST=https://your.posthog.instance`.

### Events tracked

| Event | When |
|-------|------|
| `worker_started` / `worker_stopped` | Container lifecycle |
| `job_started` / `job_completed` | Job lifecycle |
| `job_blocked_by_circuit_breaker` | Circuit breaker open |
| `step_completed` / `step_failed` | Per step |
| `circuit_breaker_opened` / `_closed` | Circuit breaker state change |
| `sync_completed` / `sync_failed` | Sync schedule completion |
| `alert_sent` / `alert_suppressed` | Alert delivery |
| `scheduler_became_leader` | Leader election |

### Suggested PostHog dashboards

- **Success rate by integration** — `job_completed` vs `job_dead_letter` grouped by `integration`
- **Jobs throughput** — `job_started` count per minute grouped by `queue`
- **Dead-letter rate** — `job_dead_letter` / `job_started` ratio over time
- **Circuit breaker health** — `circuit_breaker_opened` events by integration

## Configure Resend

1. Verify your domain (`visionarysoft.com`) in [Resend dashboard](https://resend.com) → Domains.
2. Generate an API key → set `RESEND_API_KEY`.
3. Set `ALERT_FROM_EMAIL=alerts@visionarysoft.com`.
4. Emails go to `csantos@mycloudmenu.com` by default (override via `ALERT_EMAILS`).

Alerts are deduplicated: identical alerts within 5 minutes increment a counter rather than sending multiple emails. Severity tags: `[URGENT]`, `[WARNING]`, `[INFO]`.

## Enqueuing jobs from external code

```typescript
import { enqueueOrderInjection, enqueueSms, enqueueEmail } from 'mcm-job-engine/enqueue';

// Inject an order into Omnivore
const jobId = await enqueueOrderInjection({
  siteId: 42,
  orderId: 'ord_abc123',
  posProvider: 'omnivore',
  order: {
    order_type: 'TAKEOUT',
    items: [
      { line_id: 'l1', menu_item_id: 'mi_burger', quantity: 2, price: 1200 },
    ],
    payment: { amount: 2400, tip: 200 },
  },
  correlationId: 'req_xyz', // optional; generated by DB if omitted
});

// Send SMS
await enqueueSms({
  siteId: 42,
  to: '+15551234567',
  body: 'Your order #123 is ready!',
  reference: { type: 'order', id: 'ord_abc123' },
});

// Send email
await enqueueEmail({
  siteId: 42,
  to: 'customer@example.com',
  subject: 'Order confirmation',
  html: '<p>Thank you for your order.</p>',
});
```

## Creating sync schedules

```typescript
import { ensureSyncSchedule } from 'mcm-job-engine/enqueue';

// Run on startup for each active site+integration pair
await ensureSyncSchedule({
  siteId: 42,
  integration: 'clover',
  syncType: 'fetch_open_orders',
  intervalSeconds: 30,
  config: {}, // passed through to the sync handler
});
```

## Monitoring

### Useful SQL queries

```sql
-- Current queue depths
select queue_name, count(*) from integration_jobs
where status in ('pending','retrying') group by queue_name;

-- Dead letters in the last 24 hours
select site_id, integration, count(*), max(last_error_at)
from integration_jobs
where status = 'dead_letter' and last_error_at > now() - interval '24h'
group by site_id, integration order by count desc;

-- Stuck running jobs (lock expired)
select id, site_id, integration, locked_until
from integration_jobs
where status = 'running' and locked_until < now();
```

### Available views

| View | Purpose |
|------|---------|
| `jobs_dashboard` | Job counts by (queue, integration, status) — last 24h |
| `jobs_attention_needed` | Dead-letter and retrying jobs — last 7 days |
| `jobs_site_health` | Per-site success rate, in-flight, completed/failed |
| `sync_status` | All sync schedules with calculated health |
| `syncs_attention_needed` | Failing, disabled, or stale syncs |
| `alerts_pending_view` | Alerts waiting to be sent |
| `alerts_recent_view` | Last 100 alerts |

```sql
select * from jobs_attention_needed;
select * from sync_status where health != 'healthy';
select * from jobs_site_health order by failed_24h desc limit 10;
```

## Operations

### Reactivate dead-letter jobs

```typescript
import { bulkRetryDeadLetters } from 'mcm-job-engine/enqueue';

// Retry all Clover dead letters
await bulkRetryDeadLetters({ integration: 'clover' });

// Retry dead letters for a specific site since yesterday
await bulkRetryDeadLetters({
  siteId: 42,
  since: new Date(Date.now() - 86400_000),
  maxCount: 50,
});
```

### Pause / resume a sync schedule

```sql
update sync_schedules set status = 'paused' where site_id = 42 and integration = 'clover';
update sync_schedules set status = 'active'  where site_id = 42 and integration = 'clover';
```

### Change concurrency limits

```sql
update integration_concurrency_limits
set max_concurrency = 50
where integration = 'omnivore' and site_id is null and queue_name is null;
```

## Troubleshooting

**Worker not picking up jobs**
- Check `WORKER_QUEUE_NAME` matches the jobs' `queue_name`.
- Look for jobs with `locked_until` in the past and `status = 'running'` — `recover_stuck_jobs()` runs every minute via pg_cron, but you can call it manually.

**Circuit breaker open**
- Check `GET /` on the worker container for `circuit_breakers` state.
- Look at recent `job_step_attempts` for the integration to identify the root error.
- After fixing the external API issue, the breaker auto-transitions to `half_open` after `CB_COOLDOWN_SECONDS`.

**Alerts not arriving**
- Verify Resend domain is verified and `RESEND_API_KEY` is set.
- Check `alerts_outbox` for rows with `status = 'failed'` and `failed_reason`.
- Check `alert_send_log` — if the hourly count is at `ALERT_RATE_LIMIT_PER_HOUR`, alerts are suppressed.

**Sync stale / scheduler not running**
- Confirm exactly ONE service has `RUN_SCHEDULER=true`.
- Check pg advisory lock: `select * from pg_locks where locktype = 'advisory'`.
- Look for `scheduler_became_leader` in worker logs.

## Adding a new integration

1. Create `src/handlers/{name}/client.ts` — Axios instance with auth headers.
2. Add step handlers in `src/handlers/{name}/inject/` and/or `src/handlers/{name}/sync/`.
3. Register them via `registerHandler('name', 'step_name', handler)` inside each file.
4. Import the files in `src/handlers/registry.ts`.
5. Add a row to `integration_concurrency_limits` (or `migrations/005_seed_limits.sql`).
6. Add the integration to `WORKER_INTEGRATIONS` env var on the appropriate worker service.
