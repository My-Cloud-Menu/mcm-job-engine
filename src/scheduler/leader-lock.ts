import { Pool, PoolClient } from 'pg';
import { config, LEADER_LOCK_KEY } from '../config';
import { logger } from '../lib/logger';

let dedicatedPool: Pool | null = null;
let dedicatedClient: PoolClient | null = null;
let isLeaderState = false;

/**
 * Attempts to acquire a PostgreSQL advisory lock for scheduler leadership.
 * The lock is session-scoped: held until the connection closes.
 * Only one replica across all instances can hold it at a time.
 */
export async function tryAcquireLeaderLock(): Promise<boolean> {
  if (isLeaderState && dedicatedClient) return true;

  try {
    if (!dedicatedPool) {
      dedicatedPool = new Pool({ connectionString: config.supabase.dbUrl, ssl: { rejectUnauthorized: false }, max: 1 });
    }

    const client = await dedicatedPool.connect();

    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [LEADER_LOCK_KEY]
    );

    if (result.rows[0]?.acquired) {
      dedicatedClient = client;
      isLeaderState = true;
      logger.info('acquired scheduler leader lock');

      // If the connection dies, release leadership so another worker can take over
      client.on('error', (err) => {
        logger.error({ err }, 'leader connection error — releasing leadership');
        isLeaderState = false;
        dedicatedClient = null;
      });

      return true;
    }

    client.release();
    return false;
  } catch (err) {
    logger.error({ err }, 'leader lock acquisition failed');
    return false;
  }
}

export function isLeader(): boolean {
  return isLeaderState;
}

export async function releaseLeaderLock(): Promise<void> {
  if (dedicatedClient) {
    try {
      await dedicatedClient.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
      dedicatedClient.release();
    } catch (err) {
      logger.error({ err }, 'release leader lock failed');
    }
    dedicatedClient = null;
    isLeaderState = false;
  }
  if (dedicatedPool) {
    try { await dedicatedPool.end(); } catch {}
    dedicatedPool = null;
  }
}
