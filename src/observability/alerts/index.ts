import { supabase } from '../../lib/supabase';
import { logger } from '../../lib/logger';

export interface AlertInput {
  dedupeKey: string;
  severity: 'info' | 'warning' | 'critical';
  eventType: string;
  subject: string;
  body: string;
  metadata?: Record<string, unknown>;
  siteId?: number;
  integration?: string;
}

/**
 * Enqueues an alert for async delivery via Resend.
 * Duplicate alerts within 5 minutes are coalesced (count incremented).
 */
export async function enqueueAlert(input: AlertInput): Promise<void> {
  try {
    const { error } = await supabase.rpc('enqueue_alert', {
      p_dedupe_key: input.dedupeKey,
      p_severity: input.severity,
      p_event_type: input.eventType,
      p_subject: input.subject,
      p_body: input.body,
      p_metadata: input.metadata ?? {},
      p_site_id: input.siteId ?? null,
      p_integration: input.integration ?? null,
    });

    if (error) {
      logger.error({ err: error, alert: input }, 'failed to enqueue alert');
    }
  } catch (err) {
    logger.error({ err, alert: input }, 'enqueue_alert threw');
  }
}
