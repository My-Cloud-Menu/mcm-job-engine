/**
 * MEDICIÓN · ¿El `total` que devuelve Clover incluye el recargo de servicio?
 *
 * Existe porque `clover/sync/order-mapper.ts` PIDE `serviceCharge` en el `expand` (línea 2) y
 * luego lo TIRA (`:226 fee_lines: []`, `:235 fee_total: 0`). Antes de arreglarlo hay que saber si
 * el recargo ya va dentro de `cloverOrder.total`, porque:
 *   · el `subtotal` se calcula como `(total − impuesto)` (`:232`) → si va dentro, hoy contamina
 *     el subtotal;
 *   · y si además rellenáramos `fee_total`, se contaría dos veces.
 *
 * No se deduce leyendo. Sólo toca el banco 99990004 / merchant sandbox, y limpia lo que crea.
 */
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';

const SITE = 99990004;
const EXPAND = 'expand=serviceCharge,lineItems,lineItems.taxRates,discounts,taxRates,payments';

(async () => {
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cfg = CloverConfigSchema.parse(config);
  const c = createCloverClient(cfg, 'medir-recargo', SITE);

  const { data: sc0 } = await c.get<any>('/default_service_charge');
  console.log(`recargo del merchant: ${sc0.name} · ${sc0.percentage}% · enabled=${sc0.enabled}`);
  const estadoOriginal = sc0.enabled;

  let restaurar = false;
  try {
    if (!estadoOriginal) {
      // Se habilita SÓLO para medir, y se restaura en el finally. Es el merchant sandbox.
      await c.post('/default_service_charge', { enabled: true });
      restaurar = true;
      console.log('recargo habilitado temporalmente para medir');
    }

    // El endpoint atómico es el que Clover usa para crear una orden completa: SÍ computa totales,
    // al contrario que añadir líneas sueltas por API (medido: deja `total` en undefined).
    const { data: orden } = await c.post<any>('/atomic_order/orders', {
      orderCart: { lineItems: [{ name: 'Item medicion', price: 1000, printed: false }] },
    });
    const oid = orden.id;

    const { data: leida } = await c.get<any>(`/orders/${oid}?${EXPAND}`);
    const lineas = leida?.lineItems?.elements ?? [];
    const sumaLineas = lineas.reduce((a: number, l: any) => a + (l.price || 0), 0);
    const sumaTax = lineas.reduce((a: number, l: any) =>
      a + ((l.taxRates || []).reduce((x: number, t: any) => x + (t.taxAmount || 0), 0)), 0);

    console.log(`\norden ${oid}`);
    console.log(`  serviceCharge  : ${JSON.stringify(leida?.serviceCharge ?? null)}`);
    console.log(`  Σ líneas       : ${sumaLineas}`);
    console.log(`  Σ impuesto     : ${sumaTax}`);
    console.log(`  total de Clover: ${leida?.total}`);

    const base = sumaLineas + sumaTax;
    const delta = (leida?.total ?? 0) - base;
    console.log(`  Σ líneas+tax   : ${base}`);
    console.log(`\n  DIFERENCIA: ${delta} centavos`);
    if (leida?.total == null) {
      console.log('  ⇒ INCONCLUSO: Clover no devolvió total');
    } else if (delta === 0) {
      console.log('  ⇒ el total NO incluye el recargo: va aparte');
    } else {
      console.log(`  ⇒ el total SÍ incluye el recargo (${delta}c sobre ${sumaLineas} = ${(delta/sumaLineas*100).toFixed(1)}%)`);
    }

    try { await c.delete(`/orders/${oid}`); console.log('\n  orden borrada'); }
    catch { await c.post(`/orders/${oid}`, { state: 'Deleted' }); console.log('\n  orden marcada Deleted'); }
  } finally {
    if (restaurar) {
      await c.post('/default_service_charge', { enabled: estadoOriginal });
      const { data: fin } = await c.get<any>('/default_service_charge');
      console.log(`  recargo restaurado: enabled=${fin.enabled} (original ${estadoOriginal})`);
    }
  }
})().catch((e) => { console.error('ERROR:', e?.message, JSON.stringify(e?.response?.data ?? '')); process.exit(1); });
