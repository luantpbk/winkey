import { connect as connectNats, type NatsConnection } from 'nats';
import { Redis } from 'ioredis';
import { getEnv } from './config/env.js';
import { getDb, closeDb, registerArrayParsers } from './db/client.js';
import { initializeKeys } from './crypto/jwt.js';
import { OutboxRelay, natsOptionsFromUrl } from '@winkey/outbox';
import { ValkeyRateLimiter } from './rate-limit/valkey-limiter.js';
import { RevocationService } from './revocation/revocation.js';
import { NodeMailerSender } from './mail/mailer.js';
import { MailQueueWorker } from './mail/worker.js';
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
    natsConnection = await connectNats({
      ...natsOptionsFromUrl(env.NATS_URL),
      name: 'auth-svc',
    });
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

  // 7. Start Mail Queue Worker
  const mailer = new NodeMailerSender(env, app.log);
  const mailQueueWorker = new MailQueueWorker({
    db,
    mailer,
    logger: app.log,
    batchSize: 20,
    pollIntervalMs: 1000,
  });
  mailQueueWorker.start();

  await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
  app.log.info({ port: env.HTTP_PORT, service: 'auth-svc' }, 'auth-svc started');

  // 8. Graceful shutdown handler (SIGTERM / SIGINT)
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Graceful shutdown initiated');

    // 1. Stop accepting new HTTP requests
    await app.close();

    // 2. Stop mail queue worker and close mailer
    await mailQueueWorker.stop();
    await mailer.close();

    // 3. Stop outbox relay
    if (outboxRelay) {
      await outboxRelay.stop();
    }

    // 4. Close NATS connection
    if (natsConnection) {
      await natsConnection.drain().catch(() => {});
      await natsConnection.close().catch(() => {});
    }

    // 5. Close Valkey & DB pools
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
