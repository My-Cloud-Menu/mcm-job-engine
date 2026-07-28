/**
 * R10 / F3.7 / F4.2 · ¿A qué tender de Aloha rutea cada marca de tarjeta?
 *
 * No se puede probar end-to-end: los pagos creados por la Platform API de Clover
 * llegan SIN `cardTransaction`, así que `cardType` viene vacío y todo cae al tender
 * por defecto (verificado en vivo: 5/5 pagos con `cardType` ausente y `source=''`
 * en MCM). Un Flex real sí lo puebla.
 *
 * Pero el ruteo es una función pura del `source`, así que se cierra de forma
 * determinista contra `buildOmnivorePaymentBody` DE PRODUCCIÓN, alimentándolo con
 * el enum REAL de `cardTransaction.cardType` de Clover.
 */
import { buildOmnivorePaymentBody } from '../src/handlers/omnivore/inject/build-payment-body';

// Credenciales reales del site de certificación (mapeo de tenders de cx9oRBRi)
const creds = {
  defaultTenderId: '979',   // SPC OTHER  ← el genérico
  tenderIdCash: '1',        // CASH
  tenderIdVisa: '975',      // SPC VISA
  tenderIdMC: '976',        // SPC M/C
  tenderIdAmex: '978',      // SPC AMEX
  tenderIdDebit: '979',
  tenderIdAthMovil: '979',
};
const NOMBRE: Record<string, string> = {
  '1': 'CASH', '975': 'SPC VISA', '976': 'SPC M/C', '977': 'SPC DISC', '978': 'SPC AMEX', '979': 'SPC OTHER',
};

// Enum REAL de Clover `cardTransaction.cardType` (18 valores, del dump oficial)
const CARD_TYPES = ['VISA', 'MC', 'AMEX', 'DISCOVER', 'DINERS_CLUB', 'JCB', 'MAESTRO', 'SOLO',
  'LASER', 'CHINA_UNION_PAY', 'CARTE_BLANCHE', 'UNKNOWN', 'GIFT_CARD', 'EBT', 'GIROCARD',
  'INTERAC', 'OTHER', 'RUPAY'];

console.log('R10 · ruteo de marca de tarjeta → tender de Aloha');
console.log('   (buildOmnivorePaymentBody de producción, credenciales reales de cx9oRBRi)\n');

const genericos: string[] = [];
for (const ct of [...CARD_TYPES, '']) {
  const body: any = buildOmnivorePaymentBody(
    { id: 1, total: '20.00', tip: '0.00', source: ct, method: 'ecr-card', reference: 'r10' } as any,
    creds
  );
  const tid = String(body.tender_type);
  const esGenerico = tid === creds.defaultTenderId;
  if (esGenerico && ct !== 'DEBIT') genericos.push(ct || '(vacío)');
  console.log(`   cardType='${(ct || '(vacío)').padEnd(16)}' → tender ${tid} (${NOMBRE[tid] ?? '?'})${esGenerico ? '   ← genérico' : '  ✓'}`);
}

console.log(`\n   marcas que SÍ rutean a su tender propio: VISA, MC, AMEX  (3 de ${CARD_TYPES.length})`);
console.log(`   marcas que caen al tender genérico ${creds.defaultTenderId} (${NOMBRE[creds.defaultTenderId]}): ${genericos.length}`);
console.log(`      ${genericos.join(', ')}`);
console.log(`\n   Nota: la location cx9oRBRi TIENE tenders dedicados que MCM nunca usa —`);
console.log(`   '30 Discover' y '977 SPC DISC' existen en Aloha, pero DISCOVER no está en el mapa.`);
console.log(`   Consecuencia: el reporte de ventas por tender de Aloha agrupa Discover, Diners,`);
console.log(`   JCB, gift card, EBT e Interac bajo "SPC OTHER".`);
