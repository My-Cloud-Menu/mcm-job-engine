/**
 * FASE 1 — Reproducción ejecutable de los bugs #1 (seat) y #2 (unsent) del sync Omnivore.
 * Corre el CÓDIGO REAL del reconciliador (`mergeManagedOrderLineItems`) contra una orden real
 * de Carlos Business (10519) con ediciones locales simuladas, y compara:
 *   - PATH MANAGED      → mergeManagedOrderLineItems(existing, mapped)
 *   - PATH NO-MANAGED   → update(order): line_items = mapped (lo que escribe upsert-orders.ts:339)
 * No escribe nada en la DB. Solo prueba el comportamiento de la lógica.
 */
import { mergeManagedOrderLineItems } from '../src/handlers/omnivore/sync/merge-managed-order';

// ── ESTADO LOCAL en MCM tras ediciones del mesero (lo que vive en orders.line_items) ──
// Basado en los ítems reales de la orden 10519 (omni item_ids 105906177/178).
// El mesero: (a) reasignó "Mezcarrita" al Guest 2, (b) agregó "Tacos" SIN enviar (Guest 1).
const existing: any[] = [
  {
    id: 'lineitem-0',
    name: 'Mezcarrita',
    status: 'sent',
    quantity: 1,
    additional_properties: {
      seat: 2, // ⬅️ BUG #1: reasignación de asiento (local-only, nunca va a Omnivore)
      omnivore: { item_id: '105906177', origin: 'pos', sent: true },
    },
  },
  {
    id: 'lineitem-1',
    name: 'Jarra Mezcarrita',
    status: 'sent',
    quantity: 1,
    additional_properties: { omnivore: { item_id: '105906178', origin: 'pos', sent: true } },
  },
  {
    id: 'local-uuid-unsent-tacos',
    name: 'Tacos al Pastor (SIN ENVIAR)',
    status: 'new', // ⬅️ BUG #2: ítem draft/unsent, no inyectado a Omnivore, sin omnivore.item_id
    quantity: 2,
    additional_properties: { seat: 1 },
  },
];

// ── LO QUE OMNIVORE DEVUELVE (mapped por convertOmnivoreOrderToMCMOrder) ──
// Solo los ítems FIREADOS del ticket. Sin seat (Omnivore no lo conoce). Sin el unsent.
const mapped: any[] = [
  {
    id: 'lineitem-0',
    name: 'Mezcarrita',
    status: 'sent',
    quantity: 1,
    additional_properties: { omnivore: { item_id: '105906177', origin: 'pos', sent: true } },
  },
  {
    id: 'lineitem-1',
    name: 'Jarra Mezcarrita',
    status: 'sent',
    quantity: 1,
    additional_properties: { omnivore: { item_id: '105906178', origin: 'pos', sent: true } },
  },
];

const seatOf = (it: any) => it?.additional_properties?.seat ?? null;
const summarize = (arr: any[]) =>
  arr.map((i) => ({ name: i.name, status: i.status, seat: seatOf(i), omni: i.additional_properties?.omnivore?.item_id ?? null }));

console.log('\n================ ENTRADA (estado local tras edición del mesero) ================');
console.table(summarize(existing));

// ── PATH MANAGED (orden con omnivore_managed=true) ──
const managedResult = mergeManagedOrderLineItems(existing, mapped);
console.log('\n================ RESULTADO — PATH MANAGED (merge) ================');
console.table(summarize(managedResult));
const managedSeatOk = managedResult.find((i) => i.name === 'Mezcarrita') && seatOf(managedResult.find((i) => i.name === 'Mezcarrita')) === 2;
const managedUnsentOk = !!managedResult.find((i) => i.name.startsWith('Tacos'));

// ── PATH NO-MANAGED (clobber): update(order) → line_items = mapped (upsert-orders.ts:339) ──
const clobberResult = mapped; // lo que realmente queda en la DB tras el overwrite
console.log('\n================ RESULTADO — PATH NO-MANAGED (clobber update(order)) ================');
console.table(summarize(clobberResult));
const clobberSeatLost = !clobberResult.find((i) => seatOf(i) === 2);
const clobberUnsentLost = !clobberResult.find((i) => i.name.startsWith('Tacos'));

console.log('\n================ VEREDICTO ================');
console.log(`MANAGED  → asiento Guest2 preservado: ${managedSeatOk ? 'SÍ ✅' : 'NO ❌'} | unsent "Tacos" preservado: ${managedUnsentOk ? 'SÍ ✅' : 'NO ❌'}`);
console.log(`NO-MANAGED (clobber) → asiento Guest2 PERDIDO: ${clobberSeatLost ? 'SÍ ❌ (bug #1)' : 'no'} | unsent "Tacos" PERDIDO: ${clobberUnsentLost ? 'SÍ ❌ (bug #2)' : 'no'}`);
console.log('');
