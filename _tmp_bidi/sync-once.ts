// Corre el sync Omnivore→MCM UNA vez (mismo código que el worker pos_sync), on-demand.
import { getSiteIntegrationConfig } from '../src/lib/credentials';
import { createOmnivoreClient, OmnivoreConfigSchema } from '../src/handlers/omnivore/client';
import { fetchOmnivoreOrders } from '../src/handlers/omnivore/sync/order-mapper';
import { upsertOmnivoreOrders } from '../src/handlers/omnivore/sync/upsert-orders';

export async function syncOnce(siteId: number) {
  const { config } = await getSiteIntegrationConfig(siteId, 'omnivore', 'pos');
  const omnivoreConfig = OmnivoreConfigSchema.parse(config);
  const client = createOmnivoreClient(omnivoreConfig, 'manual-sync');
  const fetchStartIso = new Date().toISOString();
  const [recent, open] = await Promise.all([
    fetchOmnivoreOrders(client, 'today'),
    fetchOmnivoreOrders(client, 'open'),
  ]);
  const byId = new Map<string, any>();
  for (const o of [...recent, ...open]) if (o?.id) byId.set(String(o.id), o);
  const orders = [...byId.values()];
  const res = await upsertOmnivoreOrders(siteId, orders, config, fetchStartIso);
  return { ...res, fetched: orders.length };
}

if (process.argv[1] && process.argv[1].endsWith('sync-once.ts')) {
  syncOnce(Number(process.argv[2] || 55126712)).then((r) => {
    console.log('SYNC', JSON.stringify(r));
    process.exit(0);
  }).catch((e) => { console.error('SYNC ERR', e); process.exit(1); });
}
