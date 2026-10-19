import { describe, it, expect } from 'vitest';
import { buildOmnivorePaymentBody } from '../../src/handlers/omnivore/inject/build-payment-body';
import fixture from './fixtures/omnivore-site-integrations.json';

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


/** Copia EXACTA de la función antes de R9 (Misión Omnivore Multisucursal), para la prueba de igualdad. */
function legacyBody(payment: any, credentials: Record<string, any>, isOmnivoreManaged = false) {
  const toCents = (v: any) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100));
  const map: Record<string, unknown> = {
    DEBIT: credentials.tenderIdDebit, VISA: credentials.tenderIdVisa, ATH_MOVIL: credentials.tenderIdAthMovil,
    MC: credentials.tenderIdMC, AMEX: credentials.tenderIdAmex,
  };
  const payload: Record<string, unknown> = {
    type: '3rd_party', amount: toCents(payment.total) - toCents(payment.tip), tip: toCents(payment.tip),
    tender_type: map[payment.source ?? ''] || credentials.defaultTenderId, comment: `Invoice #: ${payment.invoice || payment.reference}`,
  };
  if (payment.method === 'ecr-cash') { payload.tip = 0; payload.tender_type = credentials.tenderIdCash; }
  if (isOmnivoreManaged && payment.method != null && ['stripe', 'ath-movil', 'evertec'].includes(payment.method) && credentials.tenderIdMcmPay) {
    payload.tender_type = credentials.tenderIdMcmPay;
  }
  return payload;
}

describe('R9 · tenders opcionales por marca', () => {
  const sources = ['VISA', 'DEBIT', 'MC', 'ATH_MOVIL', 'AMEX', 'DISCOVER', 'VISA_CREDIT', 'MASTERCARD_CREDIT', 'CASH_CARD', '', 'pos-market', 'Online Store'];
  const methods = ['ecr-card', 'ecr-cash', 'pos-cash', 'stripe', 'ath-movil', 'evertec', 'cod', null];
  const live = (fixture as { rows: Array<{ site_id: number; active: boolean; config: Record<string, any> }> }).rows.filter((r) => r.active);

  it('igualdad con los negocios vivos: sin las claves nuevas, el cuerpo es idéntico al de antes en todos los casos', () => {
    let checked = 0;
    for (const row of live) {
      expect(row.config.tenderIdDiscover).toBeUndefined();
      for (const source of sources) for (const method of methods) for (const managed of [false, true]) {
        const p = { id: 9, total: '31.47', tip: '4.50', source, method, reference: 'R1', invoice: null };
        expect(buildOmnivorePaymentBody(p, row.config, managed)).toEqual(legacyBody(p, row.config, managed));
        checked++;
      }
    }
    expect(checked).toBe(live.length * sources.length * methods.length * 2);
  });

  it('con la clave configurada, cada marca usa su tender', () => {
    const c = { ...creds, tenderIdDiscover: 'DISC', tenderIdVisaCredit: 'VCR', tenderIdMcCredit: 'MCR' };
    expect(buildOmnivorePaymentBody({ total: '10.00', tip: '0', source: 'DISCOVER', reference: 'r' }, c).tender_type).toBe('DISC');
    expect(buildOmnivorePaymentBody({ total: '10.00', tip: '0', source: 'VISA_CREDIT', reference: 'r' }, c).tender_type).toBe('VCR');
    expect(buildOmnivorePaymentBody({ total: '10.00', tip: '0', source: 'MASTERCARD_CREDIT', reference: 'r' }, c).tender_type).toBe('MCR');
    // *_CREDIT nunca cae a la marca de débito/visa por su cuenta
    expect(buildOmnivorePaymentBody({ total: '10.00', tip: '0', source: 'VISA_CREDIT', reference: 'r' }, creds).tender_type).toBe('DEF');
  });
});
