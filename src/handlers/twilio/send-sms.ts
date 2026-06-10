import { z } from 'zod';
import twilio from 'twilio';
import { registerHandler } from '../registry';
import { getSiteIntegrationConfig } from '../../lib/credentials';
import { HandlerError } from '../../core/types';

// Twilio error codes that indicate a permanent failure (no retry)
const NON_RETRYABLE_CODES = new Set([21211, 21610, 21614, 21408]);

const TwilioConfigSchema = z.object({
  account_sid: z.string().min(1),
  auth_token: z.string().min(1),
  from_number: z.string().min(1),
});

const InputSchema = z.object({
  to: z.string().min(1),
  body: z.string().min(1),
});

registerHandler('twilio', 'send_sms', async ({ jobPayload, job }) => {
  const input = InputSchema.parse(jobPayload);

  const { config } = await getSiteIntegrationConfig(job.site_id, 'twilio');
  const twilioConfig = TwilioConfigSchema.parse(config);

  const client = twilio(twilioConfig.account_sid, twilioConfig.auth_token);

  try {
    const message = await client.messages.create({
      from: twilioConfig.from_number,
      to: input.to,
      body: input.body,
    });

    return {
      message_sid: message.sid,
      status: message.status,
      sent_at: new Date().toISOString(),
    };
  } catch (err: unknown) {
    const twilioErr = err as { code?: number; message?: string; status?: number };

    if (twilioErr.code !== undefined && NON_RETRYABLE_CODES.has(twilioErr.code)) {
      throw new HandlerError(
        `Twilio non-retryable error ${twilioErr.code}: ${twilioErr.message}`,
        `TWILIO_${twilioErr.code}`,
        false,
        twilioErr.status
      );
    }

    throw new HandlerError(
      `Twilio error: ${twilioErr.message}`,
      `TWILIO_${twilioErr.code ?? 'UNKNOWN'}`,
      true,
      twilioErr.status
    );
  }
});
