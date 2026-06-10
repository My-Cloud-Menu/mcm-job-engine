import { Pool } from 'pg';
import { config } from '../config';

// Singleton pool used for advisory locks and direct SQL operations
export const pgPool = new Pool({
  connectionString: config.supabase.dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
