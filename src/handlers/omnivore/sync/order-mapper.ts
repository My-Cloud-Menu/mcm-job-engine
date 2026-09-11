import { AxiosInstance } from 'axios';
import { getConfiguredOpenProductIds, normalizeOpenProductName } from '../open-product';

// Puerto Rico is UTC-4 year-round (no DST) — same convention as the legacy
// `getOmnivoreOrders` (`dayjs().utcOffset(-240)`).
const PR_TZ_OFFSET_MS = -4 * 60 * 60 * 1000;
const PAGE_LIMIT = 100;

// Field projection — ported verbatim from omnivore-helper.ts:getOmnivoreOrders.
// N2: proyección recursiva de modificadores anidados (menú real anida a 4; 5 = holgura; API acepta 5-deep).
// ESPEJO byte-idéntico (string producido) de omnivore-helper.ts OMNIVORE_ORDER_FIELDS.
const OMNIVORE_MODIFIER_LEAF =
  'id,name,price,quantity,comment,menu_modifier(id,pos_id),modifier_group(id,pos_id,name)';
const nestOmnivoreModifiers = (depth: number): string =>
  depth <= 1
    ? `modifiers(${OMNIVORE_MODIFIER_LEAF})`
    : `modifiers(${OMNIVORE_MODIFIER_LEAF},${nestOmnivoreModifiers(depth - 1)})`;
const FIELDS =
  'id,name,open,opened_at,closed_at,' +
  'totals(due,paid,items,discounts,service_charges,tax,total),' +
  'employee(id,first_name,last_name),order_type(id,name),revenue_center(id,name),' +
  // `id,sent,sent_at` por ítem: llave de correlación del merge bidireccional (Fase 7).
  'table(id,name),items(id,sent,sent_at,name,comment,price,quantity,' +
  `${nestOmnivoreModifiers(5)},` +
  'menu_item(id,menu_categories(id)))';

// WS-5/F17 (auditoría 2026-06-09): ventana RODANTE sobre `opened_at` (antes era "hoy"
// calendario PR). Una mesa abierta ayer 11pm y cerrada hoy 12:30am tiene opened_at=ayer
// y quedaba fuera de la ventana "hoy" → su cierre nunca sincronizaba. La ventana rodante
// cubre el cruce de medianoche; el pase `open` cubre las mesas aún abiertas más viejas.
//
// 2026-07-27: 36h → 24h (decisión del usuario). 24h rodantes siguen cubriendo el cruce de
// medianoche (la mesa de ayer 11pm sigue dentro hasta esta noche); lo que se pierde es el
// margen extra. Consecuencia conocida: un ticket abierto hace MÁS de 24h que se cierra
// ahora sale del pase `open` y queda fuera de esta ventana → su cierre no sincroniza.
// Solo afecta mesas dejadas abiertas más de un día. Si hiciera falta cerrar ese hueco, la
// vía verificada es filtrar por `closed_at`: and(eq(open,false),gte(closed_at,now-24h)).
function getTodayWindowUnix(): { startUnix: number; endUnix: number } {
  const nowMs = Date.now();
  const LOOKBACK_MS = 24 * 60 * 60 * 1000;
  return {
    startUnix: Math.floor((nowMs - LOOKBACK_MS) / 1000),
    endUnix: Math.floor(nowMs / 1000) + 60, // +60s de holgura por skew de reloj
  };
}

// 2026-09-11: el carril de cierres pasa a filtrar por `closed_at` en vez de por `opened_at`.
// La ventana de `opened_at` medía cuánto podía durar una mesa ABIERTA (por eso eran 24h: el
// ticket más largo medido dura 21,7h) y hacía que el barrido trajera TODO lo abierto en 24h
// —2.915 tickets / 30 páginas / 159s en 70080000— sólo para detectar los cierres del rato.
// Filtrando por cuándo CERRÓ, la ventana ya no depende de la duración de la mesa (de las
// abiertas se encarga el pase `eq(open,true)`, sin cota) y basta con un margen corto.
//
// Verificado contra la API en los 4 sites vivos (2026-09-11, sólo lectura): `closed_at` viene
// poblado en 3.339/3.339 tickets cerrados, cero fugas respecto a la query anterior, y el
// payload de 51021421 cae al 8,2% (414 tickets/33,4s → 34/2,5s).
//
// ⚠️ CONTRAPARTIDA ASUMIDA (decisión del dueño): esta ventana es también el único mecanismo de
// recuperación que existe —no hay backfill ni reconciliación inversa (WS-5/F16 se propuso y no
// se implementó)—, así que un apagón del worker de más de 2h pierde esos cierres de forma
// permanente. Medido: 16 huecos >2h sin una sola corrida exitosa en 30 días. Antes los absorbía
// la ventana de 24h. Si vuelve a doler, la vía es hacerla auto-expansible con el watermark de
// `sync_schedules.last_cursor` (hoy llega al handler y se descarta), como en
// `clover/sync/fetch-payments.ts`.
export const CLOSED_LOOKBACK_HOURS = 2;

/** Inicio de la ventana del carril de cierres, en epoch SEGUNDOS (la API no acepta ms). */
export function getClosedSinceUnix(
  nowMs: number = Date.now(),
  hours: number = CLOSED_LOOKBACK_HOURS
): number {
  return Math.floor((nowMs - hours * 60 * 60 * 1000) / 1000);
}

/**
 * Fetches Omnivore tickets, following HAL `_links.next` pagination. Mirrors the
 * legacy `getOmnivoreOrders`.
 *
 * - `mode='open'`   → `eq(open,true)`. Todos los tickets abiertos, sin cota de tiempo.
 * - `mode='closed'` → los cerrados en las últimas `CLOSED_LOOKBACK_HOURS`, por `closed_at`.
 * - `mode='today'`  → ventana rodante sobre `opened_at` (24h). RETIRADO del carril de cierres
 *                     el 2026-09-11; lo conserva `fetch_recent_orders`, que es el camino de
 *                     rollback documentado. No cambiar su comportamiento.
 *
 * Consumidores: `fetch_closed_orders` usa `'closed'` + `'open'` (barrido, 90s),
 * `fetch_open_orders` usa solo `'open'` (carril rápido, 20s), y `fetch_recent_orders`
 * (retirado, schedule `disabled`) usa `'today'` + `'open'`.
 */
export async function fetchOmnivoreOrders(
  client: AxiosInstance,
  mode: 'today' | 'open' | 'closed' = 'today'
): Promise<any[]> {
  let where: string;
  if (mode === 'open') {
    where = 'eq(open,true)';
  } else if (mode === 'closed') {
    where = `and(eq(open,false),gte(closed_at,${getClosedSinceUnix()}))`;
  } else {
    const { startUnix, endUnix } = getTodayWindowUnix();
    where = `and(gte(opened_at,${startUnix}),lte(opened_at,${endUnix}))`;
  }

  const items: any[] = [];
  // First page via the client (baseURL = .../locations/{id}); subsequent pages
  // follow the absolute `_links.next.href` (axios uses absolute URLs as-is).
  let nextUrl: string | null = null;
  let firstParams: Record<string, unknown> | null = { limit: PAGE_LIMIT, where, fields: FIELDS };
  let pages = 0;

  do {
    const res: { data: any } = nextUrl
      ? await client.get(nextUrl)
      : await client.get('/tickets', { params: firstParams! });
    firstParams = null;

    const tickets = res.data?._embedded?.tickets;
    if (Array.isArray(tickets)) items.push(...tickets);

    nextUrl = res.data?._links?.next?.href ?? null;
  } while (nextUrl && ++pages < 200); // MAX_PAGES: backstop contra un _links.next malformado/cíclico

  return items;
}

// ── Order conversion (ported verbatim from omnivore-helper.ts) ───────────────

function getTaxesBreakdownOfOmnivoreOrder(omnivoreOrder: any, config: any) {
  const standardCategories: string[] = config?.standardProductsCategories || [];
  let baseStandardAmount = 0;
  let baseReducedAmount = 0;

  const items = omnivoreOrder._embedded?.items || [];

  items.forEach((item: any) => {
    const isStandardProduct = item._embedded?.menu_item?._embedded?.menu_categories?.some(
      (menuCategory: any) => standardCategories.includes(menuCategory.id)
    );
    if (isStandardProduct) {
      baseStandardAmount += item.price * item.quantity;
    } else {
      baseReducedAmount += item.price * item.quantity;
    }
  });

  const totalItemsBeforeDiscount = baseStandardAmount + baseReducedAmount;
  const totalDiscount = omnivoreOrder.totals?.discounts || 0;

  if (totalItemsBeforeDiscount > 0 && totalDiscount > 0) {
    const standardDiscount = Math.round((totalDiscount * baseStandardAmount) / totalItemsBeforeDiscount);
    const reducedDiscount = totalDiscount - standardDiscount;
    baseStandardAmount -= standardDiscount;
    baseReducedAmount -= reducedDiscount;
  }

  baseStandardAmount += omnivoreOrder?.totals?.service_charges || 0;

  const totalAmount = baseStandardAmount + baseReducedAmount;

  return [
    {
      id: 'taxline-0',
      rate: '10.5',
      label: 'Tax Estatal',
      rate_id: '10001',
      compound: false,
      subtotal: baseStandardAmount / 100,
      rate_code: 'estatal-tax',
      // `Math.round` sobre CENTAVOS enteros, no `.toFixed(2)` sobre la fracción: `700 × 0.105`
      // son 73.5 centavos, pero `(0.735).toFixed(2)` da "0.73" porque 0.735 en binario es
      // 0.73499999999999998668 → el medio centavo caía SIEMPRE hacia abajo y el desglose
      // quedaba por debajo del `total_tax` que manda el POS (verificado en las órdenes 10386
      // y 10384 de Pala Pizza). Es la misma aritmética que ya usa el builder de Clover
      // (`buildTaxRatesForClass`: `Math.round(priceInCents * r.rate)`), que por eso sí cuadra.
      tax_total: (Math.round(baseStandardAmount * 0.105) / 100).toFixed(2),
      additional_properties: {},
    },
    {
      id: 'taxline-1',
      rate: '6',
      label: 'Tax Reducido',
      rate_id: '10002',
      compound: false,
      subtotal: baseReducedAmount / 100,
      rate_code: 'reduced-tax',
      tax_total: (Math.round(baseReducedAmount * 0.06) / 100).toFixed(2),
      additional_properties: {},
    },
    {
      id: 'taxline-2',
      rate: '1',
      label: 'Tax Municipal',
      rate_id: '10004',
      compound: false,
      subtotal: totalAmount / 100,
      rate_code: 'municipal-tax',
      tax_total: (Math.round(totalAmount * 0.01) / 100).toFixed(2),
      additional_properties: {},
    },
  ];
}

/**
 * Map an Omnivore order item's `_embedded.modifiers[]` into MCM line-item
 * `attributes[]` (flat — display + Clover modifications) and the
 * `omnivoreParams[]` re-injection contract (nested). MUST stay identical to the
 * edge copy (`omnivore-helper.ts::mapOmnivoreItemModifiers`).
 */
function mapOmnivoreItemModifiers(
  item: any,
  taxClass: string
): { attributes: any[]; omnivoreParams: any[] } {
  const mods = item?._embedded?.modifiers;
  if (!Array.isArray(mods) || mods.length === 0) {
    return { attributes: [], omnivoreParams: [] };
  }

  const attributes: any[] = [];

  const buildParam = (m: any): any => {
    const menuModifier = m?._embedded?.menu_modifier;
    const modifierGroup = m?._embedded?.modifier_group;

    attributes.push({
      id: String(menuModifier?.id ?? m?.id ?? ''),
      label: modifierGroup?.name || 'Modifier',
      value: m?.name || '',
      price: ((m?.price ?? 0) / 100).toFixed(2),
      tax_class: taxClass,
      additional_properties: {},
    });

    const param: any = {
      modifier: menuModifier?.id ?? '',
      modifier_group: modifierGroup?.id ?? '',
      quantity: m?.quantity || 1,
    };
    if (m?.comment) param.comment = m.comment;
    const sub = m?._embedded?.modifiers;
    if (Array.isArray(sub) && sub.length > 0) {
      param.modifiers = sub.map(buildParam);
    }
    return param;
  };

  const omnivoreParams = mods.map(buildParam);
  return { attributes, omnivoreParams };
}

export function convertOmnivoreOrderToMCMOrder(
  omnivoreOrder: any,
  config: any,
  omnivoreIdToProductId?: Map<string, number>,
  productIdByName?: Map<string, number>,
) {
  const standardCategories: string[] = config?.standardProductsCategories || [];
  // Ids de producto global configurados. Vacío (bandera apagada) ⇒ la resolución por nombre de
  // abajo nunca entra y el mapeo es el de siempre.
  const openProductIds = getConfiguredOpenProductIds(config);

  const lineItems =
    omnivoreOrder._embedded?.items?.map((item: any, index: number) => {
      const isStandardProduct = item._embedded?.menu_item?._embedded?.menu_categories?.some(
        (menuCategory: any) => standardCategories.includes(menuCategory.id)
      );
      const taxClass = isStandardProduct ? 'standard' : 'reduced';

      const mappedModifiers = mapOmnivoreItemModifiers(item, taxClass);

      // Resolver el product_id REAL de MCM vía omnivoreId (los productos lo guardan en
      // additional_properties.omnivoreId). Si no mapea, conservar el id crudo + unmapped:true
      // (el OrderCalculator lo tratará como ítem externo verbatim → no tira).
      const omniMenuItemId = item._embedded?.menu_item?.id != null ? String(item._embedded.menu_item.id) : '';
      let mappedProductId = omnivoreIdToProductId?.get(omniMenuItemId);
      // Modo open product: TODAS las líneas que MCM inyectó vuelven con el MISMO `menu_item` (el
      // producto global), así que resolver por id las convertiría a todas en "OPEN FOOD" y
      // `isStandardProduct` clasificaría mal el tax_class. Cuando el `menu_item` es uno de los
      // open products configurados se resuelve por NOMBRE — que es exactamente lo que MCM le
      // mandó al POS. Si no casa, se deja el comportamiento de siempre (unmapped:true).
      if (openProductIds.has(omniMenuItemId)) {
        const byName = productIdByName?.get(normalizeOpenProductName(item?.name));
        if (byName != null) mappedProductId = byName;
      }
      const productId = mappedProductId ?? parseInt(omniMenuItemId || '0');
      const isSent = !!item.sent;

      return {
        id: `lineitem-${index}`,
        sku: '',
        tax: '0.00',
        name: item.name || '',
        paid: 0,
        notes: item.comment || '',
        price: (item.price / 100).toFixed(2),
        total: ((item.price * item.quantity) / 100).toFixed(2),
        quantity: item.quantity || 1,
        tax_class: taxClass,
        thumbnail: '',
        total_tax: '0',
        attributes: mappedModifiers.attributes,
        product_id: productId,
        variation_id: '',
        product_price: (item.price / 100).toFixed(2),
        variation_name: '',
        // Estado POS (el ítem rung en el terminal puede venir ya enviado a cocina).
        status: isSent ? 'sent' : 'new',
        ...(item.sent_at ? { sent_at: new Date(item.sent_at * 1000).toISOString() } : {}),
        additional_properties: {
          ...(mappedModifiers.omnivoreParams.length
            ? { omnivoreParams: mappedModifiers.omnivoreParams }
            : {}),
          // Correlación del merge + marca de origen externo (tolerancia del calculator).
          omnivore: {
            item_id: item.id != null ? String(item.id) : undefined,
            origin: 'pos',
            sent: isSent,
            ...(mappedProductId == null ? { unmapped: true } : {}),
          },
        },
      };
    }) || [];

  // `open` (top-level boolean del ticket): un ticket ABIERTO con due==0 NO está pagado
  // (está vacío, o sus ítems aún no totalizan). Solo un ticket CERRADO con due==0 es
  // "cobrado/comped". Sin este guard, una mesa abierta vacía se marcaba check-closed/
  // fulfilled y el inbound la cerraba (rompía fire/void posteriores). Tickets viejos sin
  // el campo `open` (undefined) caen al comportamiento legacy (tratados como cerrados).
  const isOpen = omnivoreOrder.open === true;
  let payment_status = 'not_fulfilled';
  if (omnivoreOrder.totals.paid > 0) {
    payment_status = omnivoreOrder.totals.due == 0 ? 'fulfilled' : 'partially_fulfilled';
  } else if (!isOpen && omnivoreOrder.totals.due == 0) {
    payment_status = 'fulfilled';
  }

  // Status de la orden sincronizada:
  //  - pagada/cerrada en Omnivore (payment_status='fulfilled') → check-closed (prioridad).
  //  - abierta CON al menos un ítem ya fireado en el POS (item.sent) → in-kitchen.
  //    Espeja la regla del propio sistema (send-to-kitchen.ts: new-order→in-kitchen cuando
  //    hay ítems 'sent'). El mapper ya estampa li.status='sent' por cada item.sent de Omnivore.
  //  - abierta SIN ítems fireados → new-order (un ticket abierto vacío/sin enviar no está "en cocina").
  let order_status = 'new-order';
  if (payment_status == 'fulfilled') {
    order_status = 'check-closed';
  } else if (lineItems.some((li: any) => li.status === 'sent')) {
    order_status = 'in-kitchen';
  }

  let experience = 'pu';
  if (omnivoreOrder?._embedded?.table?.id) experience = 'qe';

  const table_name =
    omnivoreOrder?._embedded?.table?.name || omnivoreOrder?._embedded?.table?.id || '';

  return {
    id: 0,
    site_id: 0,
    pos_id: omnivoreOrder.id,
    cart_id: null,
    trueupkey: '',
    channel: 'pos',
    experience,
    experience_reference: table_name,
    payment_method: 'ecr-card',
    status: order_status,
    payment_status,
    customer: {
      id: '',
      email: '',
      phone: '',
      last_name: '',
      first_name: omnivoreOrder?.name || '',
      additional_properties: {},
    },
    customer_notes: '',
    employee: {
      id: omnivoreOrder._embedded?.employee?.id || '',
      email: '',
      last_name: omnivoreOrder._embedded?.employee?.last_name || '',
      first_name: omnivoreOrder._embedded?.employee?.first_name || '',
    },
    shipping_address: {
      id: '',
      city: '',
      house: '',
      phone: '',
      street: '',
      latitude: '',
      postcode: '',
      last_name: '',
      longitude: '',
      reference: '',
      first_name: '',
      additional_properties: {},
    },
    table: {
      id: omnivoreOrder?._embedded?.table?.id || '',
      label: table_name,
      revenue_center_id: omnivoreOrder?._embedded?.revenue_center?.id || '',
      revenue_center_name: omnivoreOrder?._embedded?.revenue_center?.name || '',
    },
    location_id: null,
    order_type: {
      id: omnivoreOrder?._embedded?.order_type?.id || '',
      name: omnivoreOrder?._embedded?.order_type?.name || '',
    },
    line_items: lineItems,
    fee_lines: [
      {
        id: 'feeline-0',
        name: 'Maintenance & Entertainment Fee',
        total: (omnivoreOrder.totals?.service_charges / 100 || 0).toFixed(2),
        tax_class: 'standard',
        // Mismo redondeo en centavos enteros que las tax_lines (ver getTaxesBreakdownOfOmnivoreOrder).
        total_tax: (Math.round((omnivoreOrder.totals?.service_charges || 0) * 0.115) / 100).toFixed(2),
        is_taxable: false,
        additional_properties: {},
      },
    ],
    tax_lines: getTaxesBreakdownOfOmnivoreOrder(omnivoreOrder, config),
    shipping_lines: [],
    coupon_lines: [],
    pickup_time: null,
    currency: 'USD',
    subtotal: omnivoreOrder.totals.items / 100,
    discount_total: omnivoreOrder.totals?.discounts / 100 || 0,
    shipping_total: 0,
    fee_total: omnivoreOrder.totals?.service_charges / 100 || 0,
    total_tax: omnivoreOrder.totals.tax / 100,
    total: omnivoreOrder.totals.total / 100,
    paid: omnivoreOrder.totals?.paid / 100 || 0,
    tracking_link: null,
    additional_properties: {},
    coupon_feedback: { deliveryDiscount: 0, couponCodeApplied: '' },
    date_created: new Date((omnivoreOrder.opened_at || 0) * 1000).toISOString(),
    date_updated: new Date((omnivoreOrder.closed_at || omnivoreOrder.opened_at || 0) * 1000).toISOString(),
    customer_id: '',
    attachments: [],
  } as Record<string, any>;
}
