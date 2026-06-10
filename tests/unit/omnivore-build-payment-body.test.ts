import { describe, it, expect } from 'vitest';
import { buildOmnivorePaymentBody } from '../../src/handlers/omnivore/inject/build-payment-body';

// Tender ids mirror the `site_integrations.config` (camelCase) shape.
const creds = {
  defaultTenderId: 'DEF',
  tenderIdCash: 'CASH',
  tenderIdDebit: 'DEB',
  tenderIdVisa: 'VISA',
  tenderIdAthMovil: 'ATH',
  tenderIdMC: 'MC',
  tenderIdAmex: 'AMEX',
};

describe('buildOmnivorePaymentBody (port of edge builder)', () => {
  it('builds a 3rd_party body: amount = total − tip, tip in cents', () => {
    const body = buildOmnivorePaymentBody(
      { id: 1, total: '23.00', tip: '3.00', source: 'VISA', method: 'ecr-card', reference: 'CP1' },
      creds
    );
    expect(body).toEqual({
      type: '3rd_party',
      amount: 2000,
      tip: 300,
      tender_type: 'VISA',
      comment: 'Invoice #: CP1',
    });
  });

  it('maps tender by card source, falling back to default for unknown sources', () => {
    expect(
      buildOmnivorePaymentBody({ total: '10.00', tip: '0', source: 'MC', reference: 'r' }, creds).tender_type
    ).toBe('MC');
    // Clover-style card types (e.g. MASTERCARD) are not in the map → default tender.
    expect(
      buildOmnivorePaymentBody({ total: '10.00', tip: '0', source: 'MASTERCARD', reference: 'r' }, creds).tender_type
    ).toBe('DEF');
  });

  it('cash override: tip forced to 0 and cash tender', () => {
    const body = buildOmnivorePaymentBody(
      { total: '10.00', tip: '5.00', source: 'X', method: 'ecr-cash', reference: 'r' },
      creds
    );
    expect(body.tip).toBe(0);
    expect(body.tender_type).toBe('CASH');
  });

  it('handles null/empty tip without NaN', () => {
    const body = buildOmnivorePaymentBody({ total: '10.00', tip: null, source: 'VISA', reference: 'r' }, creds);
    expect(body.tip).toBe(0);
    expect(body.amount).toBe(1000);
  });
});
