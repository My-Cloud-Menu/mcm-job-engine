import { getTaxesBreakdownOfCloverOrder, modificacionesEnCentavos } from './tax-breakdown';

const EXPAND =
  'expand=employee,customers,orderType,serviceCharge,discounts,taxRates,' +
  'lineItems,lineItems.taxRates,lineItems.modifications,lineItems.discounts,' +
  'lineItems.modifierGroups,payments,payments.tender,payments.cardTransaction,' +
  'refunds,refunds.payment,device,manualTransaction,displayInfo';

const LIMIT = 100;
// UTC-4 offset in minutes
const TZ_OFFSET_MS = -4 * 60 * 60 * 1000;

function getTodayWindow(): { startOfDayMs: number; endOfDayMs: number } {
  const nowLocal = Date.now() + TZ_OFFSET_MS;
  const startOfDayLocal = nowLocal - (nowLocal % (24 * 60 * 60 * 1000));
  const startOfDayMs = startOfDayLocal - TZ_OFFSET_MS;
  const endOfDayMs = startOfDayMs + 24 * 60 * 60 * 1000 - 1;
  return { startOfDayMs, endOfDayMs };
}

export function buildOrdersUrl(
  baseUrl: string,
  offset: number,
  paymentState?: 'PAID' | 'OPEN'
): string {
  const { startOfDayMs, endOfDayMs } = getTodayWindow();
  let url =
    `${baseUrl}/orders?${EXPAND}` +
    `&filter=clientCreatedTime>=${startOfDayMs}` +
    `&filter=clientCreatedTime<=${endOfDayMs}` +
    `&orderBy=clientCreatedTime` +
    `&limit=${LIMIT}` +
    `&offset=${offset}`;
  if (paymentState) {
    url += `&filter=paymentState=${paymentState}`;
  }
  return url;
}

export function getPageLimit(): number {
  return LIMIT;
}

// El desglose vive en `tax-breakdown.ts` (espejo del edge): se extrajo para poder testearlo
// y de paso se arreglo el clasificador, que contaba la tasa `municipal` como estatal.

// `productMap` (cloverItemId → MCM product id) lets pulled line items resolve to the synced
// MCM product so the POS can act on them (edit/repeat/86); absent → falls back to the Clover id.
export const convertCloverOrderToMCMOrder = (
  cloverOrder: any,
  productMap?: Map<string, number>,
  // Mapa `id de tasa de Clover -> rate_code de MCM`. Se pasa como parametro —igual que
  // `productMap`— porque esta funcion es PURA y el mapa exige leer la integracion del site.
  taxRateIdToCode?: Record<string, string> | null,
) => {
  const lineItems =
    cloverOrder.lineItems?.elements?.map((item: any, index: number) => {
      let taxClass = 'standard';
      if (
        item.taxRates?.elements?.some((tax: any) =>
          tax.name.toLowerCase().includes('reduced')
        )
      ) {
        taxClass = 'reduced';
      }

      // Clover line-item modifications → MCM attributes (what the POS ItemRow renders) +
      // additional_properties.modifiers (canonical). Previously hardcoded [] → modifiers were
      // silently dropped on pulled orders (kitchen ticket/receipt inaccurate).
      const mods = (item?.modifications?.elements ?? []).map((m: any) => ({
        id: m?.modifier?.id ?? m?.id ?? '',
        label: m?.name ?? '',
        value: m?.name ?? '',
        price: (Number(m?.amount ?? 0) / 100),
      }));
      const cloverItemId = item?.item?.id ? String(item.item.id) : '';
      const mcmProductId = cloverItemId && productMap ? productMap.get(cloverItemId) : undefined;
      const precioConMods = (Number(item.price) || 0) + modificacionesEnCentavos(item);

      return {
        id: `lineitem-${index}`,
        sku: '',
        tax: '0.00',
        name: item.name || '',
        paid: 0,
        notes: item?.note || '',
        // La convencion del sistema es `price = product_price + Σ modificadores` y
        // `total = price × quantity` (`order-calculator.ts`); este mapper era la excepcion y
        // emitia el precio BASE. Un Espresso de 3,59 se veia como 1,99 al abrirlo en MCM.
        price: (precioConMods / 100).toFixed(2),
        total: (precioConMods / 100).toFixed(2),
        quantity: 1,
        tax_class: taxClass,
        thumbnail: '',
        total_tax: '0',
        attributes: mods,
        product_id: mcmProductId != null ? String(mcmProductId) : cloverItemId,
        variation_id: '',
        product_price: (item.price / 100).toFixed(2),
        variation_name: '',
        // `origin: 'pos'` por paridad con el mapper de Omnivore (omnivore/sync/order-mapper.ts:279).
        // Es metadato forense —nada ramifica sobre él— pero sin esto una línea nacida en el
        // terminal sólo lo recibía al pasar por el merge, o sea nunca en su primer pull.
        additional_properties: { modifiers: mods, clover: { line_item_id: item?.id ?? null, clover_item_id: cloverItemId, origin: 'pos' } },
      };
    }) || [];

  let payment_status = 'not_fulfilled';
  if (cloverOrder.paymentState === 'PAID') payment_status = 'fulfilled';
  else if (cloverOrder.paymentState === 'PARTIALLY_PAID') payment_status = 'partially_fulfilled';

  let order_status = 'new-order';
  if (payment_status === 'fulfilled') order_status = 'check-closed';

  const taxTotal = (cloverOrder?.taxRates?.elements || []).reduce(
    (acc: number, tax: any) => acc + tax.amount,
    0
  );

  // ── El total del POS, cuando Clover no lo calcula ────────────────────────────────────────────
  // MEDIDO (H-N15): Clover **no computa `order.total`** cuando las líneas se añaden una a una por
  // API — que es exactamente como funciona el modo gestionado (`addLineItemsToCloverTicket`).
  // Devuelve `undefined`, y `undefined / 100` es `NaN`, que acaba en la base como `total: null`.
  // Evidencia: 3 de las 6 órdenes gestionadas del banco tienen `total` y `subtotal` en NULL con
  // `paid` de 7.00, 5.00 y 20.00 — cobradas sin total.
  //
  // El respaldo se calcula igual que el push (`clover-helper.ts:2144`): Σ(precio + su impuesto)
  // de las mismas líneas. Es el número que el propio Clover muestra en el Register.
  //
  // Sólo actúa cuando Clover NO da el total, así que los caminos que hoy funcionan —órdenes
  // nacidas en el terminal, y las que MCM empuja fijando `orderBody.total`— no cambian nada.
  const totalDeLineas = (cloverOrder?.lineItems?.elements || []).reduce(
    (acc: number, li: any) =>
      acc + (li?.price || 0) +
      // Mismo defecto hermano que el precio de linea: sin esto el subtotal de la ORDEN se come
      // los modificadores y el total no cuadra con el POS.
      modificacionesEnCentavos(li) +
      // OJO: `taxRates` viene como `{ elements: [...] }`, NO como array — lo demuestra el propio
      // `taxClass` de arriba, que hace `item.taxRates?.elements?.some(...)`. Escribir
      // `(li?.taxRates || [])` devolvía el OBJETO y reventaba con «.reduce is not a function»,
      // tumbando `fetch_open_orders` y `fetch_closed_orders` enteros (94 dead-letters en el banco
      // el 2026-08-27). Se aceptan las dos formas por si alguna ruta trae ya el array.
      ((li?.taxRates?.elements ?? li?.taxRates ?? []) as any[])
        .reduce((a: number, t: any) => a + (t?.taxAmount || 0), 0),
    0
  );
  const orderTotalCents =
    typeof cloverOrder?.total === 'number' ? cloverOrder.total : totalDeLineas;
  const discountTotal = (cloverOrder?.discounts?.elements || []).reduce(
    (acc: number, d: any) => acc + d.amount,
    0
  );
  const paidTotal = (cloverOrder?.payments?.elements || []).reduce(
    (acc: number, p: any) => acc + p.amount,
    0
  );

  return {
    id: 0,
    site_id: 0,
    clover_pos_id: cloverOrder.id,
    cart_id: null,
    trueupkey: '',
    channel: 'pos',
    experience: 'pu',
    experience_reference: '',
    payment_method: 'ecr-card',
    status: order_status,
    payment_status,
    customer: {
      id: '',
      email: '',
      phone: '',
      last_name: '',
      first_name: '',
      additional_properties: {},
    },
    customer_notes: cloverOrder?.note || '',
    employee: {
      id: cloverOrder?.employee?.id || '',
      email: '',
      last_name: '',
      first_name: cloverOrder?.employee?.name || '',
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
    table: { id: '', label: '', revenue_center_id: '' },
    location_id: null,
    menu_id: null,
    order_type: {
      id: cloverOrder?.orderType?.id || '',
      name: cloverOrder?.orderType?.label || '',
    },
    line_items: lineItems,
    fee_lines: [],
    tax_lines: getTaxesBreakdownOfCloverOrder(cloverOrder, taxRateIdToCode),
    shipping_lines: [],
    coupon_lines: [],
    pickup_time: null,
    currency: 'USD',
    subtotal: (orderTotalCents - taxTotal) / 100,
    discount_total: discountTotal / 100,
    shipping_total: 0,
    fee_total: 0,
    total_tax: taxTotal / 100,
    total: orderTotalCents / 100,
    paid: paidTotal / 100,
    tracking_link: null,
    additional_properties: {},
    coupon_feedback: { deliveryDiscount: 0, couponCodeApplied: '' },
    date_created: new Date(cloverOrder.clientCreatedTime).toISOString(),
    date_updated: new Date(cloverOrder.modifiedTime).toISOString(),
    customer_id: '',
    attachments: [],
  };
};
