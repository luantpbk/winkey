import { connect as connectNats, type NatsConnection } from 'nats';
import { Redis } from 'ioredis';
import { getEnv } from './config/env.js';
import { getDb, closeDb } from './db/client.js';
import { OutboxRelay } from '@winkey/outbox';
import { ValkeyRateLimiter } from './rate-limit/valkey-limiter.js';
import { VideoProjectionConsumer } from './projection/consumer.js';
import { buildApp } from './server.js';

async function main() {
  const env = getEnv();

  // 1. Connect to database
  const { db } = getDb(env.DATABASE_URL);

  // 2. Connect to NATS JetStream
  let natsConnection: NatsConnection | null = null;
  try {
    natsConnection = await connectNats({ servers: env.NATS_URL });
  } catch (err) {
    console.warn('Warning: Could not connect to NATS on startup. Outbox relay delayed:', err);
  }

  // 3. Connect to Valkey (Redis)
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

  // 4. Start Outbox Relay worker for schema "social"
  let outboxRelay: OutboxRelay | null = null;
  if (natsConnection) {
    outboxRelay = new OutboxRelay({
      db,
      natsConnection,
      schema: 'social',
      batchSize: 100,
      pollIntervalMs: 500,
      cleanupMaxAgeDays: 7,
    });
    outboxRelay.start();
  }

  // 5. Start projection consumer for stream "VIDEO"
  let projectionConsumer: VideoProjectionConsumer | null = null;
  if (natsConnection) {
    projectionConsumer = new VideoProjectionConsumer({
      db,
      natsConnection,
    });
    await projectionConsumer.start();
  }

  // 6. Build and listen HTTP app
  const app = await buildApp({
    env,
    db,
    rateLimiter,
    redis: valkeyClient,
    natsConnection,
  });

  await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
  app.log.info({ port: env.HTTP_PORT, service: 'social-svc' }, 'social-svc started');

  // 7. Graceful shutdown handler (SIGTERM / SIGINT)
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Graceful shutdown initiated');

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
