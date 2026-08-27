/**
 * LECTURA PURA · segunda pasada. Sólo GET, no escribe nada.
 *
 * La primera pasada dejó dos preguntas abiertas:
 *   1. Los ids de pago saltan de dos en dos (95420418, 95420420, 95420422).
 *      ¿Existieron 95420419 y 95420421? Serían los tenders del PRIMER intento.
 *   2. Un ticket tiene DOS pagos y uno vale 0. ¿Cuál es su `status`?
 *
 * Vuelca el objeto `payment` COMPLETO y prueba a leer por id los huecos.
 */
import 'dotenv/config';
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../../src/handlers/omnivore/client';

const SITE = 1173690;
const TICKETS = ['20260827-10003', '20260827-30003', '20260827-30004', '20260827-10027'];
/** Los ids que faltan en la secuencia, más los conocidos como control. */
const IDS_A_SONDEAR = ['95420417', '95420418', '95420419', '95420420', '95420421', '95420422'];

(async () => {
  const { config } = await getSiteIntegrationConfig(SITE, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), 'diag-lectura-2');

  console.log('=== VOLCADO COMPLETO DE PAGOS · sólo GET ===\n');

  for (const t of TICKETS) {
    console.log(`\n──────── ticket ${t} ────────`);
    try {
      const r = await client.get<any>(`/tickets/${t}/payments`);
      const pagos = r.data?._embedded?.payments ?? [];
      console.log(`  count=${r.data?.count}  pagos=${pagos.length}`);
      pagos.forEach((p: any, i: number) => {
        const { _links, _embedded, ...resto } = p ?? {};
        console.log(`  [${i}] ${JSON.stringify(resto)}`);
        if (_embedded) console.log(`       _embedded: { ${Object.keys(_embedded).join(', ')} }`);
      });
    } catch (e: any) {
      console.log(`  FALLÓ ${e?.response?.status}: ${JSON.stringify(e?.response?.data ?? e?.message).slice(0, 200)}`);
    }
  }

  // ¿Existen los ids que faltan en la secuencia? Se sondean contra el PRIMER ticket;
  // si Omnivore los resuelve globalmente, dirá a qué ticket pertenecen.
  console.log(`\n\n=== SONDEO de ids sueltos (GET /tickets/${TICKETS[0]}/payments/<id>) ===`);
  for (const id of IDS_A_SONDEAR) {
    try {
      const r = await client.get<any>(`/tickets/${TICKETS[0]}/payments/${id}`);
      const { _links, _embedded, ...resto } = r.data ?? {};
      console.log(`  ${id} → ${r.status}  ${JSON.stringify(resto)}`);
    } catch (e: any) {
      const st = e?.response?.status;
      const slug = e?.response?.data?.errors?.[0]?.error ?? '';
      console.log(`  ${id} → ${st ?? 'ERR'} ${slug}`);
    }
  }

  console.log('\n=== fin · no se escribió nada ===');
})();
