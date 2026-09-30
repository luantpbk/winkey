import { connect as connectNats, type NatsConnection } from 'nats';
import { Redis } from 'ioredis';
import { getEnv } from './config/env.js';
import { getDb, closeDb, registerArrayParsers } from './db/client.js';
import { initializeKeys } from './crypto/jwt.js';
import { OutboxRelay } from '@winkey/outbox';
import { ValkeyRateLimiter } from './rate-limit/valkey-limiter.js';
import { RevocationService } from './revocation/revocation.js';
import { buildApp } from './server.js';

async function main() {
  const env = getEnv();

  // 1. Initialize RSA signing keys in memory
  await initializeKeys(env);

  // 2. Connect to database
  const { db, pool } = getDb(env.DATABASE_URL);
  await registerArrayParsers(pool);

  // 3. Connect to NATS JetStream
  let natsConnection: NatsConnection | null = null;
  try {
    natsConnection = await connectNats({ servers: env.NATS_URL });
  } catch (err) {
    console.warn('Warning: Could not connect to NATS on startup. Outbox relay delayed:', err);
  }

  // 4. Connect to Valkey (Redis)
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
  const revocationService = new RevocationService(valkeyClient);

  // 5. Start Outbox Relay worker
  let outboxRelay: OutboxRelay | null = null;
  if (natsConnection) {
    outboxRelay = new OutboxRelay({
      db,
      natsConnection,
      schema: 'auth',
      batchSize: 100,
      pollIntervalMs: 500,
      cleanupMaxAgeDays: 7,
    });
    outboxRelay.start();
  }

  // 6. Build and listen HTTP app
  const app = await buildApp({
    env,
    db,
    rateLimiter,
    redis: valkeyClient,
    revocationService,
    natsConnection,
  });

  await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
  app.log.info({ port: env.HTTP_PORT, service: 'auth-svc' }, 'auth-svc started');

  // 7. Graceful shutdown handler (SIGTERM / SIGINT)
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Graceful shutdown initiated');

    // 1. Stop accepting new HTTP requests
    await app.close();

    // 2. Stop outbox relay
    if (outboxRelay) {
      await outboxRelay.stop();
    }

    // 3. Close NATS connection
    if (natsConnection) {
      await natsConnection.drain().catch(() => {});
      await natsConnection.close().catch(() => {});
    }

    // 4. Close Valkey & DB pools
    await rateLimiter.close();
    await closeDb();

    app.log.info('Graceful shutdown completed');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error starting auth-svc:', err);
  process.exit(1);
});
