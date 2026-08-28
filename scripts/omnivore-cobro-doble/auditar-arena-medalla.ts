/**
 * LECTURA PURA · Arena Medalla (51021421, NEGOCIO VIVO). Sólo GET, no escribe NADA.
 *
 * Las 6 órdenes donde un error AMBIGUO (`pos_failure` / `ECONNABORTED` — el POS fue alcanzado y
 * pudo haber aplicado el pago) fue seguido de un RE-POSTEO, porque el reconcile-before-repost
 * casaba por `comment` y ese campo vuelve `null`.
 *
 * Se cuentan los tenders de cada ticket. La firma de un duplicado, medida en Numen, es un segundo
 * tender con importe 0 y `change` = el importe del primero.
 */
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../../src/handlers/omnivore/client';

const SITE = 51021421;
const CASOS = [
  { orden: 23822, ticket: '20260808-30024',  pago: 35.67,  dia: '08-ago', error: 'POS_FAILURE' },
  { orden: 23909, ticket: '20260808-100256', pago: 7.99,   dia: '08-ago', error: 'POS_FAILURE' },
  { orden: 31032, ticket: '20260821-140073', pago: 282.81, dia: '22-ago', error: 'POS_FAILURE' },
  { orden: 31057, ticket: '20260821-80019',  pago: 32.44,  dia: '22-ago', error: 'ECONNABORTED' },
  { orden: 31187, ticket: '20260821-140103', pago: 71.22,  dia: '22-ago', error: 'POS_FAILURE' },
  { orden: 31828, ticket: '20260822-230083', pago: 143.07, dia: '23-ago', error: 'ECONNABORTED' },
];

(async () => {
  const { config } = await getSiteIntegrationConfig(SITE, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), 'auditoria-lectura');

  console.log('=== AUDITORÍA · Arena Medalla · SÓLO LECTURA ===\n');
  let sospechosos = 0, ilegibles = 0, limpios = 0;

  for (const c of CASOS) {
    try {
      const r = await client.get<any>(`/tickets/${c.ticket}/payments`);
      const pagos = r.data?._embedded?.payments ?? [];
      const importes = pagos.map((p: any) => Number(p?.amount ?? 0) / 100);
      // Firma del duplicado: un tender de importe 0 con `change` > 0 (entró sobre un ticket saldado).
      const ceroConCambio = pagos.filter((p: any) => Number(p?.amount) === 0 && Number(p?.change) > 0);
      const repetidoMismoImporte = importes.filter((v: number) => Math.abs(v - c.pago) < 0.005).length;

      const sospechoso = ceroConCambio.length > 0 || repetidoMismoImporte > 1;
      if (sospechoso) sospechosos++; else limpios++;

      console.log(`${sospechoso ? '⚠️ ' : '✓ '} orden ${c.orden} · ${c.dia} · pago $${c.pago} · ${c.error}`);
      console.log(`     ${pagos.length} tender(s): ${importes.map((v: number) => '$' + v.toFixed(2)).join(', ') || '(ninguno)'}`);
      if (ceroConCambio.length) console.log(`     ⚠️  ${ceroConCambio.length} tender(s) de importe 0 con cambio — firma del duplicado`);
      if (repetidoMismoImporte > 1) console.log(`     ⚠️  ${repetidoMismoImporte} tenders del MISMO importe que el pago`);
    } catch (e: any) {
      ilegibles++;
      console.log(`?  orden ${c.orden} · ${c.dia} — NO LEGIBLE: ${e?.response?.status ?? ''} ${e?.response?.data?.errors?.[0]?.error ?? e?.message}`);
    }
  }

  console.log(`\n${limpios} sin indicio · ${sospechosos} sospechosos · ${ilegibles} no legibles`);
  console.log('=== fin · no se escribió nada ===');
})().catch((e) => { console.error('ERROR:', e?.message); process.exit(1); });
