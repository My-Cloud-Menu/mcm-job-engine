/**
 * Per-site in-process token bucket for Clover CATALOG polling (G1/G13).
 *
 * Why: every recurring sync runs on queue `pos_sync` and shares ONE circuit breaker
 * instance (`clover:pos_sync`). A burst of 429s from a large first-time catalog sweep
 * could open that breaker and starve production order/payment PULL. This limiter caps the
 * request RATE per site (the `(queue,integration,site)` concurrency limits cap parallelism,
 * not rate) so catalog fetches never accumulate enough failures to trip the shared breaker.
 *
 * In-process (per worker) is sufficient at current scale — same rationale as the existing
 * per-process circuit breaker. Not used by the order/payment PULL paths (unchanged).
 */

const QPS = Math.max(1, Number(process.env.CLOVER_CATALOG_QPS ?? 4)); // sustained tokens/sec/site
const BURST = Math.max(1, Number(process.env.CLOVER_CATALOG_BURST ?? 6)); // bucket capacity

interface Bucket {
  tokens: number;
  last: number; // ms epoch of last refill
}
const buckets = new Map<number, Bucket>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Acquire one token for `siteId`, waiting (yielding) until one is available. */
export async function acquireCloverCatalogToken(siteId: number): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    let b = buckets.get(siteId);
    if (!b) {
      b = { tokens: BURST, last: now };
      buckets.set(siteId, b);
    }
    // refill
    const elapsed = (now - b.last) / 1000;
    if (elapsed > 0) {
      b.tokens = Math.min(BURST, b.tokens + elapsed * QPS);
      b.last = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    // wait for the next token
    const deficit = 1 - b.tokens;
    await sleep(Math.max(20, Math.ceil((deficit / QPS) * 1000)));
  }
}

/** Test/util: reset a site's bucket. */
export function _resetCloverCatalogBucket(siteId?: number): void {
  if (siteId == null) buckets.clear();
  else buckets.delete(siteId);
}
