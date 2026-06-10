import { AxiosInstance } from 'axios';

const LIMIT = 100;

/**
 * Fetches Clover payments modified at/after `sinceMs`, paginating offset-style.
 * `expand=order,refunds` so we can match the order and reflect refunds.
 */
export async function fetchCloverPayments(client: AxiosInstance, sinceMs: number): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await client.get<{ elements?: any[] }>('/payments', {
      params: { filter: `modifiedTime>=${sinceMs}`, expand: 'order,refunds', limit: LIMIT, offset },
    });
    const batch = res.data?.elements ?? [];
    all.push(...batch);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await new Promise((r) => setTimeout(r, 150));
  }
  return all;
}

export interface CloverPaymentSummary {
  cloverPaymentId: string;
  cloverOrderId: string | null;
  amount: number;
  tip: number;
  voided: boolean;
  totalRefunded: number;
  modifiedTime: number;
  externalPaymentId: string | null;
  cardType: string;
  result: string;
}

export function summarizeCloverPayment(p: any): CloverPaymentSummary {
  const refunds = p?.refunds?.elements ?? [];
  const totalRefunded = refunds.reduce((acc: number, r: any) => acc + (r.amount ?? 0), 0);
  return {
    cloverPaymentId: p?.id,
    cloverOrderId: p?.order?.id ?? null,
    amount: p?.amount ?? 0,
    tip: p?.tipAmount ?? 0,
    voided: p?.result === 'VOIDED' || p?.voided === true,
    totalRefunded,
    modifiedTime: p?.modifiedTime ?? p?.createdTime ?? 0,
    externalPaymentId: p?.externalPaymentId ?? null,
    cardType: p?.cardTransaction?.cardType ?? '',
    result: p?.result ?? '',
  };
}
