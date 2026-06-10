import { z } from 'zod';
import sgMail from '@sendgrid/mail';
import { registerHandler } from '../registry';
import { getSiteIntegrationConfig } from '../../lib/credentials';
import { HandlerError } from '../../core/types';

const SendGridConfigSchema = z.object({
  api_key: z.string().min(1),
  from_email: z.string().email().optional(),
  from_name: z.string().optional(),
});

const InputSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().optional(),
  from_email: z.string().email().optional(),
  from_name: z.string().optional(),
});

registerHandler('sendgrid', 'send_email', async ({ jobPayload, job }) => {
  const input = InputSchema.parse(jobPayload);

  const { config } = await getSiteIntegrationConfig(job.site_id, 'sendgrid');
  const sgConfig = SendGridConfigSchema.parse(config);

  sgMail.setApiKey(sgConfig.api_key);

  const from = {
    email: input.from_email ?? sgConfig.from_email ?? 'noreply@mycloudmenu.com',
    name: input.from_name ?? sgConfig.from_name ?? 'My Cloud Menu',
  };

  try {
    const [response] = await sgMail.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      customArgs: { correlation_id: job.correlation_id },
    });

    return {
      status_code: response.statusCode,
      sent_at: new Date().toISOString(),
    };
  } catch (err: unknown) {
    const sgErr = err as { code?: number; message?: string; response?: { status?: number } };

    // 4xx errors other than 429 are not retryable (bad request / auth)
    const statusCode = sgErr.response?.status;
    const retryable = !statusCode || statusCode === 429 || statusCode >= 500;

    throw new HandlerError(
      `SendGrid error: ${sgErr.message}`,
      `SENDGRID_${sgErr.code ?? 'UNKNOWN'}`,
      retryable,
      statusCode
    );
  }
});
