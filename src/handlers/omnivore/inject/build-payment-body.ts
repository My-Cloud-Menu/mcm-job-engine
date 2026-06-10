/**
 * Port of the edge `buildOmnivorePaymentBody` (omnivore-helper.ts:462-499).
 * Builds the EXACT 3rd-party Omnivore payment body for a completed MCM payment.
 *
 * MUST stay byte-equivalent with the edge copy — both feed the same
 * `omnivore.payment_injection` handler. DO NOT change the field shape. Used by
 * the Clover-pull → Omnivore forward (`upsert-payments.ts`), where the
 * job-engine itself is the producer (no edge round-trip available).
 */

interface PaymentLike {
  id?: string | number;
  total?: string | number | null;
  tip?: string | number | null;
  source?: string | null;
  method?: string | null;
  invoice?: string | null;
  reference?: string | null;
}

/**
 * Mirrors the edge `convertStringNumberToCents` (`Decimal(value).mul(100)`).
 * Payment money is 2-decimal, so round-on-multiply is exact (avoids float drift)
 * and dependency-free.
 */
function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  return Math.round(Number(value) * 100);
}

export function buildOmnivorePaymentBody(
  payment: PaymentLike,
  credentials: Record<string, any>
): Record<string, unknown> {
  const TENDERTYPEID = credentials.defaultTenderId;
  const CASH_TENDER_ID = credentials.tenderIdCash;

  const TENDER_TYPE_BY_CARD: Record<string, unknown> = {
    DEBIT: credentials.tenderIdDebit, // SPC OTHER
    VISA: credentials.tenderIdVisa, // SPC VISA
    ATH_MOVIL: credentials.tenderIdAthMovil, // SPC OTHER
    MC: credentials.tenderIdMC, // SPC M/C
    AMEX: credentials.tenderIdAmex, // SPC AMEX
  };

  const totalAmountToSend = toCents(payment.total) - toCents(payment.tip);

  const payload: Record<string, unknown> = {
    type: '3rd_party',
    amount: totalAmountToSend,
    tip: toCents(payment.tip),
    tender_type: TENDER_TYPE_BY_CARD[payment.source ?? ''] || TENDERTYPEID,
    comment: `Invoice #: ${payment.invoice || payment.reference}`,
  };

  // Cash Payment
  if (payment.method === 'ecr-cash') {
    payload.tip = 0;
    payload.tender_type = CASH_TENDER_ID;
  }

  return payload;
}
