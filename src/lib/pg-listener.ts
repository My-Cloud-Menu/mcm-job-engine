import { Client } from 'pg';
import { config } from '../config';
import { logger } from './logger';

type NotifyCallback = (payload: string) => void;

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 10_000;

export class PgListener {
  private client: Client | null = null;
  private channels = new Map<string, NotifyCallback>();
  private reconnecting = false;
  private reconnectAttempts = 0;

  async connect(): Promise<void> {
    this.client = new Client({
      connectionString: config.supabase.dbUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8_000,
    });

    this.client.on('error', (err) => {
      logger.error({ err }, 'pg-listener connection error');
      this.scheduleReconnect();
    });

    this.client.on('end', () => {
      logger.warn('pg-listener connection ended');
      this.scheduleReconnect();
    });

    this.client.on('notification', (msg) => {
      const cb = this.channels.get(msg.channel);
      if (cb) cb(msg.payload ?? '');
    });

    await this.client.connect();
    this.reconnectAttempts = 0; // reset on success
  }

  async listen(channel: string, callback: NotifyCallback): Promise<void> {
    this.channels.set(channel, callback);
    if (this.client) {
      await this.client.query(`LISTEN "${channel}"`);
    }
  }

  async close(): Promise<void> {
    this.reconnecting = true;
    if (this.client) {
      try { await this.client.end(); } catch {}
      this.client = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnecting) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.warn(
        { attempts: this.reconnectAttempts },
        'pg-listener gave up reconnecting — running in polling-only mode. Check DATABASE_URL credentials.'
      );
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;

    setTimeout(async () => {
      this.reconnecting = false;
      try {
        await this.connect();
        for (const channel of this.channels.keys()) {
          await this.client!.query(`LISTEN "${channel}"`);
        }
        logger.info('pg-listener reconnected');
      } catch (err) {
        logger.warn({ err, attempt: this.reconnectAttempts }, 'pg-listener reconnect failed');
        this.scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }
}
