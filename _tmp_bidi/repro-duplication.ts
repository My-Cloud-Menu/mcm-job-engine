/**
 * Repro LIMPIO del merge para el bug de DUPLICACIÓN (Mesa 33).
 * Corre mergeManagedOrderLineItems real bajo 3 escenarios para aislar cuándo duplica.
 * No toca DB.
 */
import { mergeManagedOrderLineItems } from '../src/handlers/omnivore/sync/merge-managed-order';

const omni = (item_id: string) => ({ omnivore: { item_id, origin: 'pos', sent: true } });
const sig = (i: any) => `${i.name}/${i.status}/${i.additional_properties?.omnivore?.item_id ?? 'NO-OID'}`;
const show = (label: string, arr: any[]) => {
  console.log(`\n[${label}] n=${arr.length}`);
  for (const i of arr) console.log('   ', sig(i));
  // detectar duplicados por nombre
  const byName: Record<string, number> = {};
  for (const i of arr) byName[i.name] = (byName[i.name] ?? 0) + 1;
  const dups = Object.entries(byName).filter(([, n]) => n > 1);
  console.log('    DUPLICADOS:', dups.length ? dups.map(([n, c]) => `${n}×${c}`).join(', ') : 'ninguno');
};

// Ticket Omnivore (mapped): 1 ítem fireado del producto 100.
const mapped = [{ id: 'lineitem-0', name: 'Taco', status: 'sent', product_id: 100, quantity: 1, additional_properties: omni('555') }];

// ── Escenario 1: ítem MCM 'sent' SIN oid (stamping del fire falló) → ¿adopción evita dup? ──
const ex1 = [{ id: 'mcm-a', name: 'Taco', status: 'sent', product_id: 100, quantity: 1, additional_properties: {} }];
show('1) MCM sent SIN oid (esperado: ADOPTADO, sin dup)', mergeManagedOrderLineItems(ex1, mapped));

// ── Escenario 2: ítem MCM 'new' (sin firear) del MISMO producto que el ticket → ¿dup? ──
const ex2 = [{ id: 'mcm-b', name: 'Taco', status: 'new', product_id: 100, quantity: 1, additional_properties: {} }];
show('2) MCM new (unfired) mismo producto (sospecha: DUP)', mergeManagedOrderLineItems(ex2, mapped));

// ── Escenario 3: ítem MCM con status NULL (estado corrupto observado en 10524) → ¿dup? ──
const ex3 = [{ id: 'mcm-c', name: 'Taco', status: undefined as any, product_id: 100, quantity: 1, additional_properties: {} }];
show('3) MCM status=null mismo producto (estado observado en 10524)', mergeManagedOrderLineItems(ex3, mapped));

// ── Escenario 4: ítem MCM 'sent' con oid que YA NO matchea el ticket (Aloha re-emitió id) ──
const ex4 = [{ id: 'mcm-d', name: 'Taco', status: 'sent', product_id: 100, quantity: 1, additional_properties: omni('999') }];
show('4) MCM sent con oid viejo 999 vs ticket 555 (esperado: viejo→voided + nuevo añadido)', mergeManagedOrderLineItems(ex4, mapped));
