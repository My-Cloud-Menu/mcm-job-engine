import { supabase } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { sendAlertEmail } from './resend-channel';
import { canSend, recordSent } from './rate-limiter';
import { trackEvent } from '../posthog';

let running = true;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface AlertRow {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  event_type: string;
  subject: string;
  body: string;
  count: number;
  site_id: number | null;
  integration: string | null;
  metadata: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Long-running loop that drains alerts_outbox and sends emails via Resend.
 * Should run in only ONE replica (controlled by RUN_ALERT_DISPATCHER=true).
 */
export async function startAlertDispatcher(): Promise<void> {
  logger.info('alert dispatcher started');

  while (running) {
    try {
      const { data: alerts, error } = await supabase
        .from('alerts_outbox')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(20);

      if (error) {
        logger.error({ err: error }, 'failed to fetch pending alerts');
        await sleep(10_000);
        continue;
      }

      if (!alerts || alerts.length === 0) {
        await sleep(5_000);
        continue;
      }

      for (const alert of alerts as AlertRow[]) {
        await processAlert(alert);
      }
    } catch (err) {
      logger.error({ err }, 'alert dispatcher loop error');
      await sleep(10_000);
    }
  }
}

async function processAlert(alert: AlertRow): Promise<void> {
  const recipients = config.alerts.recipients;

  const allowedRecipients: string[] = [];
  const blockedRecipients: string[] = [];

  for (const recipient of recipients) {
    if (await canSend(recipient)) {
      allowedRecipients.push(recipient);
    } else {
      blockedRecipients.push(recipient);
    }
  }

  if (allowedRecipients.length === 0) {
    await supabase.rpc('mark_alert_suppressed', {
      p_alert_id: alert.id,
      p_reason: `Rate limit exceeded for all recipients: ${blockedRecipients.join(', ')}`,
    });

    trackEvent('alert_suppressed', {
      alert_id: alert.id,
      reason: 'rate_limit',
      severity: alert.severity,
    });
    return;
  }

  try {
    await sendAlertEmail({
      to: allowedRecipients,
      subject: buildSubject(alert),
      body: buildBody(alert),
    });

    for (const recipient of allowedRecipients) {
      await recordSent(recipient);
    }

    await supabase.rpc('mark_alert_sent', { p_alert_id: alert.id });

    trackEvent('alert_sent', {
      alert_id: alert.id,
      severity: alert.severity,
      event_type: alert.event_type,
      recipients_count: allowedRecipients.length,
    });

    logger.info({ alert_id: alert.id, severity: alert.severity }, 'alert sent');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown';
    logger.error({ err, alert_id: alert.id }, 'alert send failed');

    await supabase.rpc('mark_alert_failed', {
      p_alert_id: alert.id,
      p_reason: message,
    });
  }
}

function buildSubject(alert: AlertRow): string {
  const tag: Record<string, string> = {
    critical: '[URGENT]',
    warning: '[WARNING]',
    info: '[INFO]',
  };
  const severityTag = tag[alert.severity] ?? '[ALERT]';
  const countTag = alert.count > 1 ? ` (x${alert.count})` : '';
  return `${severityTag} ${alert.subject}${countTag}`;
}

function buildBody(alert: AlertRow): string {
  const lines = [
    alert.body,
    '',
    '---',
    `Severity: ${alert.severity}`,
    `Event Type: ${alert.event_type}`,
    `Count: ${alert.count}`,
    `First seen: ${alert.first_seen_at}`,
    `Last seen: ${alert.last_seen_at}`,
  ];

  if (alert.site_id) lines.push(`Site ID: ${alert.site_id}`);
  if (alert.integration) lines.push(`Integration: ${alert.integration}`);
  if (alert.metadata && Object.keys(alert.metadata).length > 0) {
    lines.push('', 'Metadata:', JSON.stringify(alert.metadata, null, 2));
  }

  return lines.join('\n');
}

export function stopAlertDispatcher(): void {
  running = false;
}
