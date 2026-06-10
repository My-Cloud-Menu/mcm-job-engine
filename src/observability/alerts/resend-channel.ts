import { Resend } from 'resend';
import { config } from '../../config';
import { logger } from '../../lib/logger';

let resend: Resend | null = null;

if (config.alerts.enabled) {
  resend = new Resend(config.alerts.resendApiKey);
}

export async function sendAlertEmail(params: {
  to: string[];
  subject: string;
  body: string;
}): Promise<void> {
  if (!resend) {
    logger.warn('Resend not configured, skipping alert email');
    return;
  }

  const { error } = await resend.emails.send({
    from: config.alerts.fromEmail,
    to: params.to,
    subject: params.subject,
    text: params.body,
  });

  if (error) {
    throw new Error(`Resend error: ${(error as { message?: string }).message ?? JSON.stringify(error)}`);
  }
}
