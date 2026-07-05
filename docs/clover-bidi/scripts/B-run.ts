/* Slice B integration harness — runs the real Clover catalog sync handlers against the
 * sandbox merchant + DEV DB for a given site. Invoked with tsx so it exercises the ACTUAL
 * registered handlers (not a reimplementation). Never prints secrets.
 *
 * Usage: npx tsx docs/clover-bidi/scripts/B-run.ts <site_id> [products|employees|item_stock|all]
 */
import 'dotenv/config';
import '../../../src/handlers/load-handlers';
import { getHandler } from '../../../src/handlers/registry';

const siteId = Number(process.argv[2] || 99990001);
const which = process.argv[3] || 'all';

function makeInput(stepName: string) {
  const job: any = {
    id: `b-run-${stepName}`,
    site_id: siteId,
    correlation_id: `clover-bidi-B-run-${stepName}`,
    integration: 'clover',
    queue_name: 'pos_sync',
    job_type: stepName,
    payload: { manual: true },
  };
  return {
    stepInput: { manual: true },
    jobPayload: { manual: true },
    context: {},
    job,
    step: { step_name: stepName, idempotency_key: null } as any,
  };
}

async function run(stepName: string) {
  const handler = getHandler('clover', stepName);
  if (!handler) throw new Error(`no handler clover.${stepName}`);
  const t0 = Date.now();
  const res = await handler(makeInput(stepName) as any);
  console.log(`\n=== clover.${stepName} (site ${siteId}) in ${Date.now() - t0}ms ===`);
  console.log(JSON.stringify(res, null, 2));
}

(async () => {
  const steps = which === 'all' ? ['fetch_products', 'fetch_employees', 'fetch_item_stock'] : [`fetch_${which}`];
  for (const s of steps) await run(s);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e?.message || e, e?.code || ''); process.exit(1); });
