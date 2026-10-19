import './omnivore/inject/create-order';
import './omnivore/inject/add-items';
import './omnivore/inject/create-payment';
import './omnivore/inject/payment';
// Sync de órdenes en 2 carriles: fetch_open_orders (20s, solo abiertas) + fetch_closed_orders
// (90s, barrido completo que detecta los cierres). `fetch-recent-orders` (el schedule anterior,
// ahora disabled) se conserva registrado para los jobs en vuelo y para el rollback.
import './omnivore/sync/fetch-recent-orders';
import './omnivore/sync/fetch-open-orders';
import './omnivore/sync/fetch-closed-orders';
import './omnivore/sync/fetch-tables';
import './omnivore/sync/fetch-products';
import './omnivore/sync/fetch-employees';
import './omnivore/sync/fetch-health';
import './omnivore/sync/fetch-clock-entries';
import './omnivore/sync/fetch-stock';

import './clover/inject/create-order';
import './clover/inject/create-supplemental-order';
import './clover/inject/reconcile-items';
import './clover/inject/payment';
import './clover/sync/fetch-open-orders';
import './clover/sync/fetch-closed-orders';
import './clover/sync/fetch-payments';
import './clover/sync/push-orders';
// clover-bidi (ADDITIVE): catalog inbound sync — gated per-tenant, default OFF.
import './clover/sync/fetch-products';
import './clover/sync/fetch-employees';
import './clover/sync/fetch-item-stock';
import './clover/sync/fetch-tables';

import './twilio/send-sms';
import './sendgrid/send-email';

// F2-B · cierre automático (push): el scheduler enqueue auto_settle_dispatch por site cada ~10 min.
import './auto-settle/dispatch';

// Order actions · delivery dispatch (cola order_actions): disparado cuando la orden pasa a ready-for-pickup
// (el prep-timer pg_cron mueve in-kitchen → ready-for-pickup; ahí encola order-notification-status-change-trigger).
import './delivery/dispatch';

// Printing (cola printing): push de impresión QZ (vía gateway WS) y Star (REST). Epson es pull
// (lo sirve mcm-print-service) + reaper pg_cron; no tiene handler de engine.
import './printing/dispatch-qz';
import './printing/dispatch-star';

// Suscripciones (cola billing): cobro recurrente, dunning y avisos del módulo `subs_*`.
import './subs/noop';              // humo: verifica cola + worker + registro sin tocar dinero
import './subs/apply-payment';     // un pago completado -> suscripciones + su primer periodo
import './subs/harvest-instrument';// recoge la tarjeta guardada (delega en la edge, que tiene las llaves)
import './subs/invoice-period';    // abre el ciclo siguiente (no cobra)
import './subs/charge-invoice';    // LA VIA NORMAL: un cargo por cliente, no uno por equipo
import './subs/external-sync';     // conector del servicio externo (D-055): activar/suspender/reactivar el equipo
import './subs/charge-period';     // cobra el ciclo vencido; una declinacion NO se reintenta aqui
import './subs/dispatch-notifications'; // vacia la bandeja de avisos del negocio

// Tienda (cola billing): la confirmación retrasada de Test Card (proveedor de pago simulado).
import './store/test-card-complete';
import './store/reconcile-payments';   // conciliación de cobros de la tienda (pg_cron encola cada 10 min)
