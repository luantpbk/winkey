import { connect as connectNats, type NatsConnection } from 'nats';
import { Redis } from 'ioredis';
import { getEnv } from './config/env.js';
import { getDb, closeDb } from './db/client.js';
import { OutboxRelay, natsOptionsFromUrl } from '@winkey/outbox';
import { ValkeyRateLimiter } from './rate-limit/valkey-limiter.js';
import { VideoProjectionConsumer } from './projection/consumer.js';
import { buildApp } from './server.js';

async function main() {
  const env = getEnv();

  // 1. Connect to database
  const { db } = getDb(env.DATABASE_URL);

  // 2. Connect to Valkey (Redis)
  let valkeyClient: Redis | null = null;
  try {
    valkeyClient = new Redis(env.VALKEY_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  } catch (err) {
    console.warn('Warning: Could not connect to Valkey on startup:', err);
  }

  const rateLimiter = new ValkeyRateLimiter(env.VALKEY_URL, valkeyClient ?? undefined);

  // 3. Connect to NATS JetStream, OutboxRelay & VideoProjectionConsumer with periodic retry
  let natsConnection: NatsConnection | null = null;
  let outboxRelay: OutboxRelay | null = null;
  let projectionConsumer: VideoProjectionConsumer | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  const trySetupNatsAndServices = async () => {
    try {
      if (!natsConnection || natsConnection.isClosed()) {
        try {
          natsConnection = await connectNats({
            ...natsOptionsFromUrl(env.NATS_URL),
            name: 'social-svc',
          });
          console.log('Connected to NATS JetStream');
        } catch (err) {
          console.warn(
            'Warning: Could not connect to NATS. Will retry in 10s:',
            (err as Error).message,
          );
          return;
        }
      }

      if (!outboxRelay && natsConnection) {
        outboxRelay = new OutboxRelay({
          db,
          natsConnection,
          schema: 'social',
          batchSize: 100,
          pollIntervalMs: 500,
          cleanupMaxAgeDays: 7,
        });
        outboxRelay.start();
        console.log('Outbox relay started');
      }

      if (natsConnection && (!projectionConsumer || !projectionConsumer.isRunning())) {
        if (!projectionConsumer) {
          projectionConsumer = new VideoProjectionConsumer({
            db,
            natsConnection,
          });
        }
        const started = await projectionConsumer.start();
        if (started) {
          console.log('Projection consumer started');
        }
      }
    } catch (err) {
      console.warn('Warning during NATS/services startup/retry:', err);
    }
  };

  await trySetupNatsAndServices();

  // Periodic retry (~10s) if NATS, outbox relay, or projection consumer not yet started
  retryTimer = setInterval(async () => {
    if (
      !natsConnection ||
      natsConnection.isClosed() ||
      !outboxRelay ||
      !projectionConsumer ||
      !projectionConsumer.isRunning()
    ) {
      await trySetupNatsAndServices();
    }
  }, 10_000);

  // 4. Build and listen HTTP app
  const app = await buildApp({
    env,
    db,
    rateLimiter,
    redis: valkeyClient,
    natsConnection,
  });

  await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
  app.log.info({ port: env.HTTP_PORT, service: 'social-svc' }, 'social-svc started');

  // 5. Graceful shutdown handler (SIGTERM / SIGINT)
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Graceful shutdown initiated');

    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }

    // Stop accepting new HTTP requests
    await app.close();

    // Stop projection consumer
    if (projectionConsumer) {
      await projectionConsumer.stop();
    }

    // Stop outbox relay
    if (outboxRelay) {
      await outboxRelay.stop();
    }

    // Close NATS connection
    if (natsConnection) {
      await natsConnection.drain().catch(() => {});
      await natsConnection.close().catch(() => {});
    }

    // Close Valkey & DB pools
    await rateLimiter.close();
    await closeDb();

    app.log.info('Graceful shutdown completed');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error starting social-svc:', err);
  process.exit(1);
});
