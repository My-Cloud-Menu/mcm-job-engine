import { z } from 'zod';
import { registerHandler } from '../../registry';
import { getSiteIntegrationConfig } from '../../../lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../client';
import { HandlerError } from '../../../core/types';

// Assumption: Clover payments use tender ids (cash, card, etc.).
// amount is in cents.
const InputSchema = z.object({
  tender_id: z.string().optional(),
  amount: z.number().int().min(0),
  tip_amount: z.number().int().min(0).default(0),
  external_payment_id: z.string().optional(),
  note: z.string().optional(),
});

registerHandler('clover', 'create_payment', async ({ jobPayload, context, job, step }) => {
  const orderId = (context['create_order'] as Record<string, unknown>)?.['clover_order_id'];
  if (!orderId) {
    throw new HandlerError('Missing clover_order_id in context', 'MISSING_CONTEXT', false);
  }

  const input = InputSchema.parse(
    (jobPayload['payment'] as Record<string, unknown>) ?? jobPayload
  );

  const { config } = await getSiteIntegrationConfig(job.site_id, 'clover');
  const cloverConfig = CloverConfigSchema.parse(config);
  const client = createCloverClient(cloverConfig, job.correlation_id);

  const body: Record<string, unknown> = {
    amount: input.amount,
    tipAmount: input.tip_amount,
    order: { id: orderId },
  };
  if (input.tender_id) body['tender'] = { id: input.tender_id };
  if (input.external_payment_id) body['externalPaymentId'] = input.external_payment_id;
  if (input.note) body['note'] = input.note;

  const response = await client.post<{ id: string }>(
    `/orders/${orderId}/payments`,
    body,
    {
      headers: {
        'Idempotency-Key': step.idempotency_key ?? `${job.id}:create_payment`,
      },
    }
  );

  if (!response.data?.id) {
    throw new HandlerError('Clover payment response missing id', 'MISSING_PAYMENT_ID', false);
  }

  return { payment_id: response.data.id };
});
