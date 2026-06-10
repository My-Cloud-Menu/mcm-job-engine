import { supabase } from '../lib/supabase';
import { logger } from '../lib/logger';
import { tryAcquireLeaderLock, isLeader } from './leader-lock';
import { trackEvent } from '../observability/posthog';

const SCHEDULER_INTERVAL_MS = 5_000;
const LEADER_RETRY_INTERVAL_MS = 10_000;
const BATCH_LIMIT = 50;

let running = true;
let wasLeader = false;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Scheduler loop. Only the leader replica runs sync schedule claims.
 * Non-leaders retry lock acquisition every 10 seconds.
 */
export async function startScheduler(): Promise<void> {
  logger.info('scheduler started, attempting to acquire leadership');

  while (running) {
    try {
      if (!isLeader()) {
        const acquired = await tryAcquireLeaderLock();
        if (!acquired) {
          await sleep(LEADER_RETRY_INTERVAL_MS);
          continue;
        }
        if (!wasLeader) {
          logger.info('became scheduler leader');
          trackEvent('scheduler_became_leader');
          wasLeader = true;
        }
      }

      const { data, error } = await supabase.rpc('claim_due_schedules', {
        p_limit: BATCH_LIMIT,
      });

      if (error) {
        logger.error({ err: error }, 'claim_due_schedules failed');
      } else if (data && (data as unknown[]).length > 0) {
        logger.info({ enqueued: (data as unknown[]).length }, 'scheduler enqueued sync jobs');
      }

      await sleep(SCHEDULER_INTERVAL_MS);
    } catch (err) {
      logger.error({ err }, 'scheduler loop error');
      await sleep(10_000);
    }
  }
}

export function stopScheduler(): void {
  running = false;
}
