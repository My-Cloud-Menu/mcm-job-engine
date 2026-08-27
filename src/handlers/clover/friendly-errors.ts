import { AxiosError } from 'axios';

/**
 * Traduce un fallo de Clover a algo que un encargado pueda leer y accionar.
 *
 * POR QUÉ EXISTE: lo que hoy acaba delante de una persona es el `HandlerError` crudo — cosas como
 * `"Clover 400: Section id required"`. El worker **no tiene capa de mensajes para NINGUNA de las
 * dos integraciones**; la buena vive entera en las edge functions
 * (`_shared/helpers/clover-friendly-errors.ts`) y el worker no la importa jamás. Esto lo cierra
 * para Clover. **No se toca el carril de Omnivore**, que está en producción.
 *
 * NO ES UN ESPEJO del fichero de la edge, a propósito. Esa convención existe en el repo (4 casos)
 * pero **no hay ningún control que verifique que los espejos siguen sincronizados**, y ya han
 * divergido: `ticket_locked` es `ACTIONABLE` en la edge y no-reintentable en el worker. Aquí se
 * escribe desde la evidencia medida, y se documenta qué se dejó fuera.
 *
 * ── Lo que está VERIFICADO contra el merchant sandbox ────────────────────────────────────────
 *   · `400 {"message":"Section id required"}`
 *   · `404 {"message":"Not Found","details":"Could not find section RSYHTEDTCDWJP"}`
 *   · `404 {"message":"Not Found","details":"Order not found."}`
 *   · `405 "405 GET not allowed."` — y OJO: en Clover **405 significa RUTA DESCONOCIDA**, no
 *     "método no permitido". Verificado contra `/merchant_plans/{id}`, que SÍ existe y también
 *     responde 405.
 *   · `400 {"message":"Can not delete order with an associated payment."}`
 *
 * ── Lo que NO se porta de la edge, y por qué ─────────────────────────────────────────────────
 * La regla `msg.includes("payment")` → *"El ticket ya tiene un pago aplicado"*
 * (`clover-friendly-errors.ts:85-87`). Dos motivos:
 *   1. Su única evidencia es un test con un string inventado; no hay ni una respuesta de Clover
 *      transcrita que lo respalde.
 *   2. **Se midió lo contrario** (H-N9): Clover **acepta** un segundo pago sobre una orden ya
 *      pagada, sin error alguno. Esa rama busca un mensaje que Clover probablemente nunca envía.
 * Además casaría cualquier texto que contenga «payment» (`"payment method not supported"`…) y le
 * diría al operador que el ticket ya está cobrado. Si algún día se captura la respuesta real, se
 * añade con su evidencia.
 */

/** Qué puede hacer quien lo lee. */
export type CloverErrorTier =
  /** El negocio puede resolverlo: el ticket cambió, hay que revisar la orden. */
  | 'actionable'
  /** Transitorio: se reintenta solo. */
  | 'generic'
  /** Configuración o integración rota: hace falta soporte. */
  | 'structural';

export interface CloverFriendly {
  tier: CloverErrorTier;
  /** Para la persona. En español, sin jerga, sin códigos. */
  message: string;
  /** Para el log. */
  detail: string | null;
  status: number | null;
}

/**
 * Extrae el texto útil del cuerpo de Clover.
 *
 * Lee `message` **y `details`**. El worker hoy sólo mira `message`
 * (`error-map.ts:30-37`), y `details` es justo donde Clover pone lo concreto:
 * `{"message":"Not Found","details":"Order not found."}`.
 */
export function extractCloverDetail(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() || null;
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const msg = typeof b['message'] === 'string' ? (b['message'] as string) : null;
  const det = typeof b['details'] === 'string' ? (b['details'] as string) : null;
  if (msg && det) return `${msg}: ${det}`;
  return msg ?? det ?? null;
}

const M = {
  network: 'El POS no está respondiendo. Se reintenta solo en unos segundos.',
  rate: 'El POS está saturado de peticiones. Se reintenta solo.',
  server: 'El POS tuvo un error interno. Se reintenta solo.',
  auth: 'La conexión con el POS no está autorizada. Avisa a soporte.',
  unknownRoute: 'Esta operación no está disponible en el POS. Avisa a soporte.',
  notFound: 'El ticket o el ítem ya no existen en el POS.',
  hasPayment: 'El ticket ya tiene un pago: el POS no deja modificarlo.',
  missingField: 'Al POS le falta un dato para aceptar la operación. Avisa a soporte.',
  rejected: 'El POS rechazó la operación.',
} as const;

/**
 * Clasifica por STATUS, que es lo estable, y sólo afina por texto en los casos medidos.
 *
 * Acepta las DOS formas que circulan por el motor, y esto no es cortesía: el error crudo de axios
 * (con `response.status`) y el `HandlerError` que ya produjo `mapCloverError` (con `statusCode` y
 * `responseBody`). Los handlers atrapan el segundo, así que si sólo se entendiera el primero, esta
 * capa devolvería «el POS no responde» para todo — que es exactamente el fallo silencioso que
 * viene a evitar.
 */
export function classifyCloverError(err: unknown): CloverFriendly {
  const ax = err as AxiosError | undefined;
  const isAxios =
    ax instanceof AxiosError ||
    (typeof err === 'object' && err !== null && (err as Record<string, unknown>)['isAxiosError'] === true);

  let status: number | null;
  let detail: string | null;

  if (isAxios && ax) {
    status = ax.response?.status ?? null;
    detail = extractCloverDetail(ax.response?.data) ?? ax.message ?? null;
  } else if (
    typeof err === 'object' && err !== null &&
    ('statusCode' in err || 'responseBody' in err)
  ) {
    // Forma `HandlerError`.
    const he = err as { statusCode?: number; responseBody?: unknown; message?: string };
    status = typeof he.statusCode === 'number' ? he.statusCode : null;
    detail = extractCloverDetail(he.responseBody) ?? he.message ?? null;
  } else {
    const e = err as Error | undefined;
    return { tier: 'generic', message: M.network, detail: e?.message ?? null, status: null };
  }
  const texto = (detail ?? '').toLowerCase();

  if (status == null) return { tier: 'generic', message: M.network, detail, status };
  if (status === 429) return { tier: 'generic', message: M.rate, detail, status };
  if (status >= 500) return { tier: 'generic', message: M.server, detail, status };
  if (status === 401 || status === 403) return { tier: 'structural', message: M.auth, detail, status };

  // 405 = ruta desconocida en esta API. Medido.
  if (status === 405) return { tier: 'structural', message: M.unknownRoute, detail, status };
  if (status === 404) return { tier: 'actionable', message: M.notFound, detail, status };

  // Medido literal al intentar borrar una orden pagada.
  if (texto.includes('associated payment')) {
    return { tier: 'actionable', message: M.hasPayment, detail, status };
  }
  // Medido: "Section id required", "Table coordinates are required".
  if (texto.includes('required')) {
    return { tier: 'structural', message: M.missingField, detail, status };
  }

  return { tier: 'actionable', message: M.rejected, detail, status };
}
