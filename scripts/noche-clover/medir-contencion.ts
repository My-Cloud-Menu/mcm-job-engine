/**
 * MEDICIÓN · ¿Qué devuelve Clover de verdad cuando se paga una orden que YA tiene pago?
 *
 * Existe porque en todo el monorepo NO hay ni una sola respuesta capturada de Clover para este
 * caso. El texto "already has payments" que circula por tests, migraciones y auditorías **lo
 * escribe MCM** (`clover-helper.ts`), no Clover. Escribir una regla de contención sobre esa
 * conjetura sería repetir el error del `Idempotency-Key`, que se dio por bueno hasta medirlo.
 *
 * Mide además dos cosas de las que depende el reconcile entero y que nunca se comprobaron:
 *   · ¿`?expand=payments` devuelve el campo `note`?  (el ancla vive ahí)
 *   · ¿el `amount` que devuelve Clover coincide con el que se envía? (para poder compararlo)
 *
 * Sólo toca el banco de pruebas 99990004 / merchant sandbox. Limpia lo que crea.
 */
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createCloverClient, CloverConfigSchema } from '../../src/handlers/clover/client';

const SITE = 99990004;
const out: string[] = [];
const log = (l: string) => { console.log(l); out.push(l); };

async function main() {
  const { config } = await getSiteIntegrationConfig(SITE, 'clover', 'pos');
  const cfg = CloverConfigSchema.parse(config);
  const client = createCloverClient(cfg, 'medir-contencion', SITE);
  log(`merchant=${cfg.merchantId}\n`);

  // 1. orden con una línea
  const { data: orden } = await client.post<any>('/orders', { state: 'open', title: 'MEDICION contencion' });
  const oid = orden.id;
  await client.post(`/orders/${oid}/line_items`, { name: 'Item medicion', price: 500 });
  log(`orden ${oid} creada con 1 línea de $5.00`);

  // 2. primer pago, con ancla en `note`
  const ancla = `mcm:pay:${SITE}:999901`;
  const { data: pago1 } = await client.post<any>(`/orders/${oid}/payments`, {
    amount: 500, tender: { id: (cfg as any).defaultTenderId || '4QPPVE0NFNBN4' }, note: ancla,
  });
  log(`pago 1 aplicado: ${pago1?.id}  amount=${pago1?.amount}`);

  // 3. ¿sobrevive `note` a `expand=payments`? — de esto depende TODO el reconcile
  const { data: leida } = await client.get<any>(`/orders/${oid}?expand=payments`);
  const pagos = leida?.payments?.elements ?? [];
  log(`\n── expand=payments ──`);
  log(`pagos devueltos: ${pagos.length}`);
  log(`claves del pago: ${Object.keys(pagos[0] ?? {}).join(', ')}`);
  log(`note presente: ${pagos[0]?.note !== undefined ? 'SÍ' : 'NO'}  valor=${JSON.stringify(pagos[0]?.note)}`);
  log(`note === ancla enviada: ${pagos[0]?.note === ancla}`);
  log(`amount devuelto=${pagos[0]?.amount}  enviado=500  coinciden=${pagos[0]?.amount === 500}`);
  log(`estado de la orden tras pagar: state=${JSON.stringify(leida?.state)}`);

  // 4. EL CASO: segundo pago sobre la orden ya pagada
  log(`\n── 2º pago sobre orden YA pagada ──`);
  try {
    const { data: pago2 } = await client.post<any>(`/orders/${oid}/payments`, {
      amount: 500, tender: { id: (cfg as any).defaultTenderId || '4QPPVE0NFNBN4' }, note: `mcm:pay:${SITE}:999902`,
    });
    log(`NO FALLA. Clover aceptó un 2º pago: ${pago2?.id}`);
    log('⇒ no hay error de contención que clasificar en este caso.');
  } catch (e: any) {
    log(`status:   ${e?.response?.status}`);
    log(`headers:  ${JSON.stringify(e?.response?.headers ?? {})}`);
    log(`body:     ${JSON.stringify(e?.response?.data)}`);
    log(`message:  ${JSON.stringify(e?.response?.data?.message)}`);
    log(`details:  ${JSON.stringify(e?.response?.data?.details)}`);
  }

  // 5. pago sobre una orden inexistente, para contrastar el 404
  log(`\n── contraste: pago sobre orden inexistente ──`);
  try {
    await client.post(`/orders/ORDENQUENOEXISTE/payments`, { amount: 100, tender: { id: (cfg as any).defaultTenderId || '4QPPVE0NFNBN4' } });
    log('NO FALLA (inesperado)');
  } catch (e: any) {
    log(`status=${e?.response?.status} body=${JSON.stringify(e?.response?.data)}`);
  }

  // limpieza
  try { await client.delete(`/orders/${oid}`); log(`\norden ${oid} borrada`); } catch { log('\nno se pudo borrar (esperado si tiene pago)'); }
}

main().then(() => {
  console.log('\n' + '='.repeat(70));
}).catch((e) => { console.error('ERROR:', e?.message ?? e, JSON.stringify(e?.response?.data ?? '')); process.exit(1); });
