import { connect as defaultConnect, type NatsConnection } from 'nats';
import type { Logger } from 'pino';
import { sanitizeEndpointUrl } from '../infra/logger.js';

export type NatsReadinessState = 'ok' | 'disconnected' | 'skipped';

export interface NatsStatusProvider {
  getReadinessState(): NatsReadinessState;
  getConnection(): NatsConnection | null;
  close(): Promise<void>;
}

export class ManagedNatsConnection implements NatsStatusProvider {
  private nc: NatsConnection | null = null;
  private isLive = false;
  private closing = false;
  private connectPromise: Promise<NatsConnection | null> | null = null;

  constructor(
    private readonly natsUrl: string | undefined,
    private readonly logger: Logger,
    private readonly connectFn: typeof defaultConnect = defaultConnect,
  ) {}

  /**
   * Start NATS connection with waitOnFirstConnect: true, reconnect: true, maxReconnectAttempts: -1.
   * Runs in the background and tracks disconnect / reconnect lifecycle.
   */
  public start(): Promise<NatsConnection | null> {
    if (!this.natsUrl) {
      return Promise.resolve(null);
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const safeEndpoint = sanitizeEndpointUrl(this.natsUrl);
    this.logger.info({ endpoint: safeEndpoint }, 'initiating NATS connection');

    this.connectPromise = this.connectFn({
      servers: this.natsUrl,
      name: 'chat-svc',
      waitOnFirstConnect: true,
      reconnect: true,
      maxReconnectAttempts: -1,
    })
      .then((conn) => {
        if (this.closing) {
          void conn.close();
          return null;
        }
        this.nc = conn;
        this.isLive = !conn.isClosed();
        this.logger.info({ endpoint: safeEndpoint }, 'NATS connected');
        this.watchLifecycle(conn, safeEndpoint);
        return conn;
      })
      .catch((err: unknown) => {
        this.isLive = false;
        this.nc = null;
        this.logger.error({ err, endpoint: safeEndpoint }, 'NATS connection failed permanently');
        return null;
      });

    return this.connectPromise;
  }

  private watchLifecycle(conn: NatsConnection, safeEndpoint: string): void {
    void (async () => {
      try {
        for await (const status of conn.status()) {
          if (status.type === 'disconnect' || status.type === 'reconnecting') {
            if (this.isLive) {
              this.isLive = false;
              this.logger.warn({ endpoint: safeEndpoint, event: status.type }, 'NATS disconnected');
            }
          } else if (status.type === 'reconnect') {
            this.isLive = true;
            this.logger.info({ endpoint: safeEndpoint, event: status.type }, 'NATS reconnected');
          }
        }
      } catch (err) {
        this.logger.warn({ err, endpoint: safeEndpoint }, 'NATS status iterator terminated');
      }
    })();

    void conn.closed().then((err) => {
      this.isLive = false;
      if (!this.closing) {
        this.logger.error({ err, endpoint: safeEndpoint }, 'NATS connection closed unexpectedly');
      }
    });
  }

  public getReadinessState(): NatsReadinessState {
    if (!this.natsUrl) {
      return 'skipped';
    }
    if (!this.nc || this.nc.isClosed() || !this.isLive) {
      return 'disconnected';
    }
    return 'ok';
  }

  public getConnection(): NatsConnection | null {
    return this.isLive && this.nc && !this.nc.isClosed() ? this.nc : null;
  }

  public async close(): Promise<void> {
    this.closing = true;
    this.isLive = false;
    if (this.nc && !this.nc.isClosed()) {
      await this.nc.drain().catch(() => this.nc?.close());
    }
    this.nc = null;
  }
}
