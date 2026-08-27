/**
 * Token bucket en proceso, por site, para TODAS las llamadas a Clover.
 *
 * Nació sólo para el sondeo de CATÁLOGO (G1/G13) y ahí estaba el hueco: la INYECCIÓN no pasaba
 * por él. Un solo `reconcile_items` puede disparar `1 GET + N DELETE + ceil(M/100) POST +
 * K POST de modificaciones + 1 POST de total`; con varios jobs en paralelo eso son cientos de
 * llamadas en ráfaga sin ningún freno. Ahora se aplica en el interceptor del cliente axios, así
 * que cubre catálogo, órdenes, pagos e inyección por igual y no hay forma de saltárselo.
 *
 * Contexto original (sigue vigente):
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

// `CLOVER_QPS`/`CLOVER_BURST` son los nombres nuevos; se conservan los antiguos por compatibilidad
// con cualquier despliegue que ya los tuviera puestos.
// Default bajado de 4 a 3 tras la simulación de servicio de esta noche: el bucket es POR PROCESO
// y en producción corren varios servicios (más réplicas de `pos-sync`), así que el merchant ve la
// SUMA. Medido con UN proceso: no hay 429 ni a 6 req/s en lectura ni a 4 req/s en escritura
// sostenida; con 3 procesos a la vez, sí. El interceptor de 429 del cliente es la red de
// seguridad; esto sólo reduce cuántas veces hace falta.
const QPS = Math.max(1, Number(process.env.CLOVER_QPS ?? process.env.CLOVER_CATALOG_QPS ?? 3));
const BURST = Math.max(1, Number(process.env.CLOVER_BURST ?? process.env.CLOVER_CATALOG_BURST ?? 4));

interface Bucket {
  tokens: number;
  last: number; // ms epoch of last refill
}
const buckets = new Map<number, Bucket>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Toma un token para `siteId`, esperando (cediendo el hilo) hasta que haya uno. Nunca rechaza. */
export async function acquireCloverToken(siteId: number): Promise<void> {
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

/** Alias histórico. El limitador ya no es sólo de catálogo. */
export const acquireCloverCatalogToken = acquireCloverToken;
