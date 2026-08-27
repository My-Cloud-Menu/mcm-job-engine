import axios, { AxiosInstance } from 'axios';
import { z } from 'zod';
import { resolveCloverBaseUrl } from './region';
import { acquireCloverToken } from './sync/rate-limit';

/** Reintentos del cliente ante un 429 antes de dejar que el error suba al handler. */
const MAX_REINTENTOS_429 = 4;

export const CloverConfigSchema = z.object({
  apiKey: z.string().min(1),
  merchantId: z.string().min(1),
  apiUrl: z.string().optional(),
  // ADDITIVE (clover-bidi): optional region hint used only when apiUrl is absent.
  region: z.string().optional(),
  sync_orders: z.boolean().default(false),
  injectOrderInStatusChange: z.boolean().optional(),
  statusChangeToTriggerInjectOrder: z.string().optional(),
  standardProductsCategories: z.array(z.string()).optional(),
  defaultEmployeeId: z.string().optional(),
  defaultOrderTypeId: z.string().optional(),
  defaultRevenueCenterId: z.string().optional(),
  // ADDITIVE (clover-bidi): per-tenant catalog-sync feature flags (default OFF via consumers).
  sync_employees: z.boolean().optional(),
  sync_tables: z.boolean().optional(),
  sync_products: z.boolean().optional(),
  sync_modifiers: z.boolean().optional(),
  sync_item_stock: z.boolean().optional(),
  cloverCatalogSyncIntervalSeconds: z.number().optional(),
  // ADDITIVE (clover-bidi): auto-maintain a POS catalog so synced products render in /pos-order.
  autoManageCloverCatalog: z.boolean().optional(),
  cloverCatalogChannels: z.array(z.string()).optional(),
  // ADDITIVE (clover-bidi): attach native catalog modifiers to pushed line items (else note fallback).
  cloverNativeModifiers: z.boolean().optional(),
  /** Modo gestionado: el mesero edita la misma mesa desde el dispositivo Clover Y desde /pos-order. */
  cloverTableServiceEnabled: z.boolean().optional(),
  /**
   * Pedir a Clover que imprima el ticket (`POST /print_event`) al terminar la inyección.
   * APAGADO por defecto: MCM ya tiene su propia plataforma de impresión y en un site con las dos
   * saldrían dos chits del mismo pedido. Ver `clover-table-service.ts::printCloverOrder`.
   */
  cloverPrintOnFire: z.boolean().optional(),
  /**
   * Respetar en el sync los campos COSMÉTICOS que se hayan editado en MCM (`name`,
   * `description`, y los nombres de categorías y modificadores). Ver
   * `sync/local-overrides.ts`. Apagada ⇒ conducta de siempre: Clover manda en todo.
   */
  cloverPreserveLocalEdits: z.boolean().optional(),
  /**
   * Desactivar en MCM (`is_active=false`) a los empleados que Clover ya no devuelve. Sólo afecta
   * a los que tienen `pos_id` (los que vinieron de Clover): un empleado creado a mano en MCM
   * nunca se toca. Apagada ⇒ el sync sigue siendo aditivo y un despedido conserva su PIN.
   */
  cloverDeactivateRemovedEmployees: z.boolean().optional(),
});

export type CloverConfig = z.infer<typeof CloverConfigSchema>;

/**
 * `siteId` es OBLIGATORIO a propósito: el token bucket es por site y se aplica en el interceptor
 * de peticiones, así que ningún camino (catálogo, órdenes, pagos, inyección) puede saltárselo.
 * Antes el límite sólo existía en el bucle de paginación del catálogo.
 */
export function createCloverClient(
  config: CloverConfig,
  correlationId: string,
  siteId: number
): AxiosInstance {
  // Backward-compatible: resolveCloverBaseUrl returns config.apiUrl verbatim when set
  // (every existing config sets it), else maps config.region, else the same US default.
  const baseUrl = resolveCloverBaseUrl(config);
  const instancia = axios.create({
    baseURL: `${baseUrl}/v3/merchants/${config.merchantId}`,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      // Clover requires a User-Agent on every request (the legacy edge omitted it).
      'User-Agent': 'MyCloudMenu-JobEngine/1.0',
      'X-Correlation-Id': correlationId,
    },
    timeout: 20_000,
  });

  // Rate limit por site ANTES de cada llamada. No rechaza: espera. El coste de saturar es
  // latencia, no un 429 que acabaría abriendo el breaker compartido de `clover:pos_sync`.
  instancia.interceptors.request.use(async (cfg) => {
    await acquireCloverToken(siteId);
    return cfg;
  });

  // Absorber el 429 aquí, y no sólo en los reintentos del job.
  //
  // **Por qué hace falta pese al bucket:** el bucket vive EN PROCESO. En producción corren
  // varios servicios (`worker-pos-sync`, `worker-pos-injection`, …) y `pos-sync` puede tener
  // réplicas, así que el merchant ve la SUMA de todos: N procesos ⇒ N×QPS. Medido en la
  // simulación de servicio de esta noche: con 2 workers + el guion de pruebas a la vez, Clover
  // devolvió 429 aunque cada proceso respetaba su límite. Con un solo proceso no aparece ni a
  // 6 req/s en lectura ni a 4 req/s en escritura sostenida.
  //
  // **Reintentar es seguro:** un 429 significa RECHAZADO, no aplicado — la petición no llegó a
  // la lógica de negocio, así que no puede duplicar nada. Es distinto de un timeout, donde no se
  // sabe, y por eso el timeout NO se reintenta aquí.
  instancia.interceptors.response.use(undefined, async (err: any) => {
    const cfg = err?.config;
    if (err?.response?.status !== 429 || !cfg) throw err;
    cfg.__reintentos429 = (cfg.__reintentos429 ?? 0) + 1;
    if (cfg.__reintentos429 > MAX_REINTENTOS_429) throw err;
    const cabecera = Number(err.response.headers?.['retry-after']);
    const espera = Number.isFinite(cabecera) && cabecera > 0
      ? Math.min(cabecera * 1000, 30_000)
      : Math.min(500 * 2 ** (cfg.__reintentos429 - 1), 8_000);
    await new Promise((r) => setTimeout(r, espera + Math.floor(Math.random() * 250)));
    return instancia.request(cfg);
  });

  return instancia;
}
