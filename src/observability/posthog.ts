import { PostHog } from 'posthog-node';
import { config } from '../config';
import { logger } from '../lib/logger';

let client: PostHog | null = null;

if (config.posthog.enabled) {
  client = new PostHog(config.posthog.apiKey, {
    host: config.posthog.host,
    flushAt: 20,
    flushInterval: 10_000,
  });
  logger.info('posthog enabled');
} else {
  logger.info('posthog disabled (no API key)');
}

/**
 * Captures a PostHog event. No-ops when PostHog is not configured.
 * Uses site_id as distinctId when available, falling back to worker id.
 */
export function trackEvent(
  event: string,
  properties: Record<string, unknown> = {}
): void {
  if (!client) return;

  try {
    const distinctId = properties['site_id']
      ? `site_${properties['site_id']}`
      : `worker_${config.worker.id}`;

    client.capture({
      distinctId: String(distinctId),
      event,
      properties: {
        ...properties,
        worker_id: config.worker.id,
        queue: config.worker.queueName,
        env: config.env,
      },
    });
  } catch (err) {
    logger.error({ err, event }, 'posthog capture failed');
  }
}

export async function shutdown(): Promise<void> {
  if (client) {
    await client.shutdown();
  }
}
