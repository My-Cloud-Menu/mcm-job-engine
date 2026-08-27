import { AxiosInstance } from 'axios';
import { logger } from '../../../lib/logger';

export type ResultadoImpresion =
  | { status: 'skip'; reason: string }
  | { status: 'printed'; print_event_id: string | null }
  | { status: 'no_device' }
  | { status: 'failed'; message: string };

/**
 * `POST /v3/merchants/{mId}/print_event` con `{"orderRef":{"id":...}}`. Clover lo enruta a la
 * impresora de órdenes del *firing device*.
 *
 * **Nunca lanza.** Un fallo de impresión no puede tumbar la inyección: la orden ya está en el
 * ticket del terminal y el negocio puede reimprimir desde ahí. Devuelve el resultado para que el
 * handler lo incluya en su salida y quede en la traza del job.
 *
 * Apagado por defecto (`cloverPrintOnFire`): MCM ya imprime por su cuenta y en un site con las dos
 * cosas saldrían dos chits. Medido contra el sandbox: sin dispositivo emparejado, Clover responde
 * `400 {"message":"The default printing device is missing"}`, que NO se arregla reintentando.
 */
export async function imprimirEnClover(
  client: AxiosInstance,
  cloverOrderId: string,
  habilitado: boolean,
  siteId: number,
): Promise<ResultadoImpresion> {
  if (!habilitado) return { status: 'skip', reason: 'cloverPrintOnFire apagado' };
  if (!cloverOrderId) return { status: 'skip', reason: 'sin ticket de Clover' };
  try {
    const { data } = await client.post('/print_event', { orderRef: { id: cloverOrderId } });
    return { status: 'printed', print_event_id: (data as any)?.id ?? null };
  } catch (e: any) {
    const crudo = String(e?.response?.data?.message ?? e?.message ?? '');
    if (/printing device is missing/i.test(crudo)) {
      logger.warn({ site_id: siteId, clover_order_id: cloverOrderId },
        'clover_print_sin_dispositivo');
      return { status: 'no_device' };
    }
    logger.warn({ site_id: siteId, clover_order_id: cloverOrderId, err: crudo },
      'clover_print_fallo');
    return { status: 'failed', message: crudo };
  }
}
