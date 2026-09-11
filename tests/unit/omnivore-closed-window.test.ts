import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchOmnivoreOrders,
  getClosedSinceUnix,
  CLOSED_LOOKBACK_HOURS,
} from '../../src/handlers/omnivore/sync/order-mapper';

/**
 * La ventana del carril de cierres NO tenía ni un solo test: `getTodayWindowUnix` era privada y
 * `fetchOmnivoreOrders` no se importaba desde ningún test, así que las dos veces que se tocó
 * (36h → 24h en julio, y ahora el cambio de eje) no había red de seguridad ninguna.
 *
 * Lo que se fija aquí:
 *
 *  1. El pase `'closed'` filtra por `closed_at` y NUNCA por `opened_at`. Es la diferencia que
 *     hace seguro bajar la ventana a 2h: si el filtro fuera por cuándo ABRIÓ el ticket, una mesa
 *     abierta hace 6 horas que se cobra ahora saldría de la ventana y su cierre no sincronizaría
 *     jamás (medido contra la API: 6 de 33 cierres de 51021421 son de mesas de más de 2h).
 *
 *  2. El epoch va en SEGUNDOS. La API rechaza milisegundos, y un `Date.now()` sin dividir da una
 *     fecha del año 58.000: la query no falla, simplemente no devuelve nada — el peor modo de
 *     fallo posible para un sync.
 *
 *  3. Los modos `'today'` y `'open'` siguen produciendo el string EXACTO de antes. `'today'` es
 *     el que usa `fetch_recent_orders`, el camino de rollback documentado: si se rompe, se rompe
 *     la vuelta atrás.
 */

// Un AxiosInstance mínimo: sólo necesitamos ver con qué `params` se llamó.
function clienteFalso() {
  const llamadas: Array<{ url: string; params?: Record<string, unknown> }> = [];
  const client = {
    get: async (url: string, cfg?: any) => {
      llamadas.push({ url, params: cfg?.params });
      return { data: { _embedded: { tickets: [] } } };
    },
  } as any;
  return { client, llamadas };
}

const AHORA_MS = 1_789_164_070_000; // 2026-09-11T21:41:10Z, la hora de la prueba contra la API
const AHORA_S = Math.floor(AHORA_MS / 1000);

describe('ventana del carril de cierres (omnivore)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AHORA_MS));
  });
  afterEach(() => vi.useRealTimers());

  describe('getClosedSinceUnix', () => {
    it('devuelve epoch en SEGUNDOS, no en milisegundos', () => {
      const t = getClosedSinceUnix();
      expect(t).toBe(AHORA_S - CLOSED_LOOKBACK_HOURS * 3600);
      // 10 dígitos = segundos. Con ms serían 13 y la API devolvería vacío sin dar error.
      expect(String(t)).toHaveLength(10);
      expect(Number.isInteger(t)).toBe(true);
    });

    it('la ventana por defecto es de 2 horas', () => {
      expect(CLOSED_LOOKBACK_HOURS).toBe(2);
      expect(AHORA_S - getClosedSinceUnix()).toBe(7200);
    });

    it('acepta otra ventana y otro `now` (para poder medir sin tocar el reloj)', () => {
      expect(getClosedSinceUnix(AHORA_MS, 24)).toBe(AHORA_S - 86400);
      expect(getClosedSinceUnix(1_000_000_000_000, 1)).toBe(1_000_000_000 - 3600);
    });
  });

  describe("mode='closed'", () => {
    it('filtra por closed_at y por open=false', async () => {
      const { client, llamadas } = clienteFalso();
      await fetchOmnivoreOrders(client, 'closed');

      expect(llamadas).toHaveLength(1);
      expect(llamadas[0].url).toBe('/tickets');
      expect(llamadas[0].params!.where).toBe(
        `and(eq(open,false),gte(closed_at,${AHORA_S - 7200}))`
      );
    });

    it('NO menciona opened_at (es justo el eje del que se sale)', async () => {
      const { client, llamadas } = clienteFalso();
      await fetchOmnivoreOrders(client, 'closed');
      expect(String(llamadas[0].params!.where)).not.toContain('opened_at');
    });

    it('pide los campos y el límite de siempre', async () => {
      const { client, llamadas } = clienteFalso();
      await fetchOmnivoreOrders(client, 'closed');
      expect(llamadas[0].params!.limit).toBe(100);
      expect(String(llamadas[0].params!.fields)).toContain('closed_at');
    });
  });

  describe('no-regresión de los modos que no se tocan', () => {
    it("'open' sigue siendo eq(open,true), sin cota de tiempo", async () => {
      const { client, llamadas } = clienteFalso();
      await fetchOmnivoreOrders(client, 'open');
      expect(llamadas[0].params!.where).toBe('eq(open,true)');
    });

    it("'today' conserva la ventana de 24h sobre opened_at (camino de rollback)", async () => {
      const { client, llamadas } = clienteFalso();
      await fetchOmnivoreOrders(client, 'today');
      expect(llamadas[0].params!.where).toBe(
        `and(gte(opened_at,${AHORA_S - 86400}),lte(opened_at,${AHORA_S + 60}))`
      );
    });

    it("'today' sigue siendo el valor por defecto", async () => {
      const { client, llamadas } = clienteFalso();
      await fetchOmnivoreOrders(client);
      expect(String(llamadas[0].params!.where)).toContain('opened_at');
    });
  });
});
