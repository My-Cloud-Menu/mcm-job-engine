/**
 * N4 · Repro ejecutable contra el mapper DE PRODUCCIÓN.
 *
 * Hipótesis: `convertOmnivoreOrderToMCMOrder` deriva `payment_status` de
 * `totals.due` solamente (order-mapper.ts:266) y NUNCA compara `paid` contra
 * `total`. Si el POS reporta un cheque totalmente cobrado pero con `due != 0`
 * —lo que pasó en vivo tras un `pos_not_responding_retry`— MCM lo marca
 * `partially_fulfilled`, y `recordExternalOmnivorePaymentIfNeeded`
 * (upsert-orders.ts:76) exige `fulfilled`, así que NO crea fila en `payments`.
 * Resultado: dinero cobrado de verdad, invisible para MCM.
 *
 * Esto no simula nada: usa el payload REAL del ticket 20260726-1010031 y el
 * mapper real. Se compara contra un control con `due=0`.
 */
import { convertOmnivoreOrderToMCMOrder } from '../src/handlers/omnivore/sync/order-mapper';

const base = {
  id: '20260726-1010031',
  open: true,
  name: 'CERT-M7c',
  _embedded: {
    items: [
      { id: 'i1', quantity: 1, price: 1300, included_tax: 0, sent: true, comment: '',
        _embedded: { menu_item: { id: '300025', name: 'Elote', _embedded: { menu_categories: [] } } } },
      { id: 'i2', quantity: 1, price: 900, included_tax: 0, sent: true, comment: '',
        _embedded: { menu_item: { id: '310170', name: 'Codorniu Cuvee Brut CP', _embedded: { menu_categories: [] } } } },
    ],
    employee: { id: '975' },
    table: { id: '601', name: '601' },
  },
};

const casos = [
  { tag: 'OBSERVADO EN VIVO  (paid=total, due≠0)', totals: { discounts: 0, due: 2419, items: 2200, paid: 2419, service_charges: 22, sub_total: 2200, tax: 197, tips: 500, total: 2419 } },
  { tag: 'CONTROL            (paid=total, due=0)', totals: { discounts: 0, due: 0,    items: 2200, paid: 2419, service_charges: 22, sub_total: 2200, tax: 197, tips: 500, total: 2419 } },
  { tag: 'CONTROL parcial    (paid<total, due≠0)', totals: { discounts: 0, due: 1219, items: 2200, paid: 1200, service_charges: 22, sub_total: 2200, tax: 197, tips: 0,   total: 2419 } },
];

console.log('N4 · mapper de producción · convertOmnivoreOrderToMCMOrder\n');
for (const c of casos) {
  const r: any = convertOmnivoreOrderToMCMOrder({ ...base, totals: c.totals }, { standardProductsCategories: [] });
  const cubierto = c.totals.paid >= c.totals.total;
  const creariaPago = r.payment_status === 'fulfilled'; // gate de recordExternalOmnivorePaymentIfNeeded
  console.log(`${c.tag}`);
  console.log(`   POS: paid=${c.totals.paid} total=${c.totals.total} due=${c.totals.due} tips=${c.totals.tips}`);
  console.log(`   MCM: payment_status=${r.payment_status}  status=${r.status}`);
  console.log(`   ¿cheque cubierto por el pago?  ${cubierto ? 'SÍ' : 'no'}`);
  console.log(`   ¿MCM crearía fila en payments? ${creariaPago ? 'sí' : 'NO'}`);
  console.log(`   ¿propina mapeada a algún campo de la orden? ${Object.keys(r).some((k) => /tip/i.test(k)) ? 'sí' : 'NO — el mapper no emite ningún campo de propina'}`);
  if (cubierto && !creariaPago) console.log(`   ✗ N4: dinero cobrado (${c.totals.paid}¢) sin rastro en MCM`);
  console.log();
}
