/**
 * LECTURA PURA · Numen (1173690). Sólo GET, no escribe nada.
 *
 * Pregunta que responde: cuando el POST devolvió `internal_error` con
 * `reason: "Error closing ticket."`, ¿se aplicó el pago o no?
 *
 * Los ids de tender de los 4 casos saltan de dos en dos (418, 420, 422, luego
 * 423 y 424). Si 417/419/421 aparecen en OTROS tickets de Numen, son actividad
 * ajena y el `internal_error` de los pagos 10001-10003 NO aplicó nada.
 * Si no aparecen en ninguno, se crearon y se revirtieron.
 *
 * Censa TODOS los tickets conocidos del site (los `pos_id` de sus órdenes) y
 * lista sus tenders.
 */
import 'dotenv/config';
import { getSiteIntegrationConfig } from '../../src/lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../../src/handlers/omnivore/client';
import { supabase } from '../../src/lib/supabase';

const SITE = 1173690;

(async () => {
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, pos_id, omnivore_pos_id, total, status')
    .eq('site_id', SITE);
  if (error) throw error;

  const tickets = Array.from(
    new Set((orders ?? []).map((o: any) => o.pos_id ?? o.omnivore_pos_id).filter(Boolean)),
  ) as string[];

  const { config } = await getSiteIntegrationConfig(SITE, 'omnivore', 'pos');
  const client = createOmnivoreClient(OmnivoreConfigSchema.parse(config), 'diag-censo');

  console.log(`=== CENSO DE TENDERS · Numen · ${tickets.length} tickets · sólo GET ===\n`);

  const todos: Array<{ ticket: string; id: string; amount: number; change: unknown }> = [];

  for (const t of tickets) {
    try {
      const r = await client.get<any>(`/tickets/${t}/payments`);
      const pagos = r.data?._embedded?.payments ?? [];
      const linea = pagos
        .map((p: any) => `${p.id}(amt=${p.amount}${p.change ? `,chg=${p.change}` : ''})`)
        .join('  ');
      console.log(`  ${t.padEnd(18)} ${pagos.length} tender(s)  ${linea}`);
      pagos.forEach((p: any) => todos.push({ ticket: t, id: String(p.id), amount: p.amount, change: p.change }));
    } catch (e: any) {
      console.log(`  ${t.padEnd(18)} FALLÓ ${e?.response?.status ?? ''} ${e?.response?.data?.errors?.[0]?.error ?? ''}`);
    }
  }

  const vistos = new Set(todos.map((p) => p.id));
  console.log(`\n=== ¿existen los ids que faltan en la secuencia? ===`);
  for (const id of ['95420415', '95420416', '95420417', '95420419', '95420421']) {
    console.log(`  ${id}: ${vistos.has(id) ? '✓ está en un ticket de Numen' : '✗ NO aparece en ningún ticket de Numen'}`);
  }

  console.log(`\n  tenders totales censados: ${todos.length}`);
  console.log(`  rango de ids: ${[...vistos].sort().join(', ')}`);
  console.log('\n=== fin · no se escribió nada ===');
})();
