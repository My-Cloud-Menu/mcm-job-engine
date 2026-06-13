import { AxiosInstance } from 'axios';

// Puerto Rico is UTC-4 year-round (no DST) — same convention as the legacy
// `getOmnivoreOrders` (`dayjs().utcOffset(-240)`).
const PR_TZ_OFFSET_MS = -4 * 60 * 60 * 1000;
const PAGE_LIMIT = 100;

// Field projection — ported verbatim from omnivore-helper.ts:getOmnivoreOrders.
const FIELDS =
  'id,name,open,opened_at,closed_at,' +
  'totals(due,paid,items,discounts,service_charges,tax,total),' +
  'employee(id,first_name,last_name),order_type(id,name),revenue_center(id,name),' +
  // `id,sent,sent_at` por ítem: llave de correlación del merge bidireccional (Fase 7).
  'table(id,name),items(id,sent,sent_at,name,comment,price,quantity,' +
  'modifiers(id,name,price,quantity,comment,menu_modifier(id,pos_id),modifier_group(id,pos_id,name)),' +
  'menu_item(id,menu_categories(id)))';

// WS-5/F17 (auditoría 2026-06-09): ventana RODANTE de 36h sobre `opened_at` (antes
// era "hoy" calendario PR). Una mesa abierta ayer 11pm y cerrada hoy 12:30am tiene
// opened_at=ayer y quedaba fuera de la ventana "hoy" → su cierre nunca sincronizaba.
// 36h cubre el cruce de medianoche; el pase `open` (fetch-recent-orders) cubre mesas
// aún abiertas más viejas.
function getTodayWindowUnix(): { startUnix: number; endUnix: number } {
  const nowMs = Date.now();
  const LOOKBACK_MS = 36 * 60 * 60 * 1000;
  return {
    startUnix: Math.floor((nowMs - LOOKBACK_MS) / 1000),
    endUnix: Math.floor(nowMs / 1000) + 60, // +60s de holgura por skew de reloj
  };
}

/**
 * Fetches Omnivore tickets, following HAL `_links.next` pagination. Mirrors the
 * legacy `getOmnivoreOrders`. `mode='today'` returns today's opened tickets
 * (open AND closed — replaces the webhook's close detection); `mode='open'`
 * returns only open tickets.
 */
export async function fetchOmnivoreOrders(
  client: AxiosInstance,
  mode: 'today' | 'open' = 'today'
): Promise<any[]> {
  let where: string;
  if (mode === 'open') {
    where = 'eq(open,true)';
  } else {
    const { startUnix, endUnix } = getTodayWindowUnix();
    where = `and(gte(opened_at,${startUnix}),lte(opened_at,${endUnix}))`;
  }

  const items: any[] = [];
  // First page via the client (baseURL = .../locations/{id}); subsequent pages
  // follow the absolute `_links.next.href` (axios uses absolute URLs as-is).
  let nextUrl: string | null = null;
  let firstParams: Record<string, unknown> | null = { limit: PAGE_LIMIT, where, fields: FIELDS };

  do {
    const res: { data: any } = nextUrl
      ? await client.get(nextUrl)
      : await client.get('/tickets', { params: firstParams! });
    firstParams = null;

    const tickets = res.data?._embedded?.tickets;
    if (Array.isArray(tickets)) items.push(...tickets);

    nextUrl = res.data?._links?.next?.href ?? null;
  } while (nextUrl);

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
      tax_total: ((baseStandardAmount * 0.105) / 100).toFixed(2),
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
      tax_total: ((baseReducedAmount * 0.06) / 100).toFixed(2),
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
      tax_total: ((totalAmount * 0.01) / 100).toFixed(2),
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
) {
  const standardCategories: string[] = config?.standardProductsCategories || [];

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
      const mappedProductId = omnivoreIdToProductId?.get(omniMenuItemId);
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
        total_tax: ((omnivoreOrder.totals?.service_charges * 0.115) / 100).toFixed(2),
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
