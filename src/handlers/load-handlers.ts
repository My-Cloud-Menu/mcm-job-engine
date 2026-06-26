import './omnivore/inject/create-order';
import './omnivore/inject/add-items';
import './omnivore/inject/create-payment';
import './omnivore/inject/payment';
import './omnivore/sync/fetch-recent-orders';
import './omnivore/sync/fetch-tables';
import './omnivore/sync/fetch-products';
import './omnivore/sync/fetch-employees';

import './clover/inject/create-order';
import './clover/inject/create-supplemental-order';
import './clover/inject/reconcile-items';
import './clover/inject/payment';
import './clover/sync/fetch-open-orders';
import './clover/sync/fetch-closed-orders';
import './clover/sync/fetch-payments';
import './clover/sync/push-orders';

import './twilio/send-sms';
import './sendgrid/send-email';

// F2-B · cierre automático (push): el scheduler enqueue auto_settle_dispatch por site cada ~10 min.
import './auto-settle/dispatch';

// Order actions · delivery dispatch (cola order_actions): disparado al aceptar la orden (in-kitchen).
import './delivery/dispatch';

// Printing (cola printing): push de impresión QZ (vía gateway WS) y Star (REST). Epson es pull
// (lo sirve mcm-print-service) + reaper pg_cron; no tiene handler de engine.
import './printing/dispatch-qz';
import './printing/dispatch-star';
