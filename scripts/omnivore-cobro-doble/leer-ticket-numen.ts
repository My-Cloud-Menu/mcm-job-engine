/**
 * LECTURA PURA contra Omnivore — site Numen (1173690).
 *
 * NO escribe nada: sólo GET. Autorizado explícitamente por el dueño el 2026-08-27
 * para diagnosticar el cobro doble de los pagos 10001/10002/10003.
 *
 * Reproduce las TRES llamadas que hace el código, para saber por qué el
 * reconcile-before-repost nunca casa (0 aciertos en 57 oportunidades):
 *
 *   A) GET /tickets/{id}/payments
 *      ← exactamente lo que hace `omnivore/inject/payment.ts:179`.
 *        ¿Devuelve `_embedded.payments`? ¿Trae `comment`?
 *
 *   B) GET /tickets/{id}?fields=totals(due,paid),payments(id)
 *      ← exactamente lo que hace `getTicketTotals` (`inject/shared.ts:78`).
 *        ¿Funciona el parámetro `fields` en este POS? (Aloha rechaza `where=eq(name,…)`.)
 *
 *   C) GET /tickets/{id}
 *      ← representación completa, sin `fields`, como control.
 */
import 'dotenv/config';
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../../src/handlers/omnivore/client';
import { supabase } from '../../src/lib/supabase';

const SITE = 1173690;

/** Recorta un objeto a sus claves de primer nivel + tipo, para no volcar datos del cliente. */
const forma = (o: unknown): string => {
  if (o === null) return 'null';
  if (Array.isArray(o)) return `array[${o.length}]`;
  if (typeof o !== 'object') return typeof o;
  return `{ ${Object.keys(o as object).join(', ')} }`;
};

(async () => {
  // Los ids de ticket salen de los propios jobs que fallaron, no se teclean.
  const { data: jobs, error } = await supabase
    .from('integration_jobs')
    .select('payload')
    .eq('site_id', SITE)
    .eq('job_type', 'payment_injection')
    .order('created_at');
  if (error) throw error;

  const casos = (jobs ?? []).map((j: any) => ({
    ticketId: j.payload?.ticket_id as string,
    paymentId: j.payload?.payment_id,
    comment: j.payload?.payment?.comment,
    amount: j.payload?.payment?.amount,
  }));

  const { config } = await getSiteIntegrationConfig(SITE, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), 'diag-lectura');

  console.log('=== LECTURA PURA · Numen 1173690 · sólo GET ===\n');

  for (const c of casos) {
    console.log(`\n──────── ticket ${c.ticketId}  (pago MCM ${c.paymentId}) ────────`);
    console.log(`   el código busca:  comment === ${JSON.stringify(c.comment)}  &&  amount === ${c.amount}`);

    // ── A · la llamada del reconcile ────────────────────────────────────────
    try {
      const r = await client.get<any>(`/tickets/${c.ticketId}/payments`);
      console.log(`\n A) GET /tickets/${c.ticketId}/payments  →  ${r.status}`);
      console.log(`    envoltorio raíz : ${forma(r.data)}`);
      console.log(`    _embedded       : ${forma(r.data?._embedded)}`);
      const pagos = r.data?._embedded?.payments;
      console.log(`    _embedded.payments : ${forma(pagos)}   ← el código lee AQUÍ`);
      if (Array.isArray(pagos)) {
        pagos.forEach((p: any, i: number) => {
          console.log(`      [${i}] claves: ${Object.keys(p ?? {}).join(', ')}`);
          console.log(`          id=${p?.id}  amount=${p?.amount}  tip=${p?.tip}  type=${p?.type}`);
          console.log(`          comment=${JSON.stringify(p?.comment)}   ${p?.comment === c.comment ? '✓ CASA' : '✗ NO CASA'}`);
        });
        const casa = pagos.find((p: any) => p?.comment === c.comment && Number(p?.amount) === Number(c.amount));
        console.log(`    ⇒ el reconcile ${casa ? 'HABRÍA adoptado' : 'NO habría adoptado'} (por eso re-posteó)`);
      }
    } catch (e: any) {
      console.log(`\n A) FALLÓ  status=${e?.response?.status}  ${JSON.stringify(e?.response?.data ?? e?.message).slice(0, 300)}`);
    }

    // ── B · la llamada de getTicketTotals ───────────────────────────────────
    try {
      const r = await client.get<any>(`/tickets/${c.ticketId}`, {
        params: { fields: 'totals(due,paid),payments(id)' },
      });
      console.log(`\n B) GET /tickets/${c.ticketId}?fields=totals(due,paid),payments(id)  →  ${r.status}`);
      console.log(`    totals   : ${JSON.stringify(r.data?.totals)}`);
      console.log(`    payments : ${forma(r.data?._embedded?.payments)}`);
    } catch (e: any) {
      console.log(`\n B) FALLÓ  status=${e?.response?.status}  ${JSON.stringify(e?.response?.data ?? e?.message).slice(0, 300)}`);
    }

    // ── C · control sin `fields` ────────────────────────────────────────────
    try {
      const r = await client.get<any>(`/tickets/${c.ticketId}`);
      console.log(`\n C) GET /tickets/${c.ticketId} (sin fields)  →  ${r.status}`);
      console.log(`    open=${r.data?.open}  totals=${JSON.stringify(r.data?.totals)}`);
      console.log(`    _embedded: ${forma(r.data?._embedded)}`);
      const pagos = r.data?._embedded?.payments;
      console.log(`    _embedded.payments: ${forma(pagos)}`);
      if (Array.isArray(pagos)) {
        pagos.forEach((p: any, i: number) =>
          console.log(`      [${i}] id=${p?.id} amount=${p?.amount} comment=${JSON.stringify(p?.comment)}`),
        );
      }
    } catch (e: any) {
      console.log(`\n C) FALLÓ  status=${e?.response?.status}  ${JSON.stringify(e?.response?.data ?? e?.message).slice(0, 300)}`);
    }
  }

  console.log('\n=== fin · no se escribió nada ===');
})();
