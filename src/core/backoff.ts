// Backoff delay profiles in seconds, indexed by attempt number (0-based).
// Keyed by job_type first (más específico), luego por queue, luego default.
const BACKOFF_PROFILES: Record<string, number[]> = {
  // Por job_type: la inyección de pago reintenta espaciada ~30s (decisión del
  // usuario) — más largo que el perfil rápido de la cola, para no martillar el POS.
  payment_injection: [30, 30, 30, 30],
  // Por cola:
  pos_injection:  [0, 5, 15, 45, 120, 300],
  pos_sync:       [10, 30, 60, 180],
  notifications:  [15, 60, 300, 900, 3600],
  webhooks:       [60, 300, 900, 3600, 21600, 86400],
  default:        [60, 300, 900, 3600, 21600],
};

/**
 * Returns the Date at which the next attempt should be scheduled,
 * or null if the attempt number exceeds the profile (→ dead_letter).
 * Applies ±20% jitter to avoid thundering herd. `jobType` (si tiene perfil
 * propio) gana sobre `queueName`.
 */
export function calculateBackoff(
  attemptNumber: number,
  queueName: string,
  jobType?: string
): Date | null {
  const profile =
    (jobType ? BACKOFF_PROFILES[jobType] : undefined) ??
    BACKOFF_PROFILES[queueName] ??
    BACKOFF_PROFILES['default']!;
  const idx = attemptNumber - 1;

  if (idx >= profile.length) return null;

  const baseSeconds = profile[idx]!;
  const jitter = baseSeconds * (Math.random() * 0.4 - 0.2);
  const totalMs = Math.max(0, (baseSeconds + jitter) * 1000);

  return new Date(Date.now() + totalMs);
}
