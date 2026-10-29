import { connect as connectNats, type NatsConnection } from 'nats';
import { Redis } from 'ioredis';
import { loadEnv } from './config/env.js';
import { getDb, closeDb } from './db/client.js';
import { ValkeyRateLimiter } from './rate-limit/valkey-limiter.js';
import { ToDevicePurgeJob } from './janitor/to-device-purge-job.js';
import { buildApp } from './server.js';

function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) return 3600_000;
  const val = parseInt(match[1], 10);
  const unit = match[2] || 'ms';
  switch (unit) {
    case 'ms':
      return val;
    case 's':
      return val * 1000;
    case 'm':
      return val * 60 * 1000;
    case 'h':
      return val * 60 * 60 * 1000;
    case 'd':
      return val * 24 * 60 * 60 * 1000;
    default:
      return val;
  }
}

async function main() {
  const env = loadEnv();

  // 1. Connect to database
  const { db, pool } = getDb(env.DATABASE_URL);

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

  // 3. Connect to NATS (core NATS publishing rt.chat.user.*)
  let natsConnection: NatsConnection | null = null;
  try {
    natsConnection = await connectNats({
      servers: env.NATS_URL,
      name: 'chat-svc',
    });
    console.log('Connected to NATS');
  } catch (err) {
    console.warn('Warning: Could not connect to NATS on startup:', (err as Error).message);
  }

  // 4. Build and listen HTTP app
  const app = await buildApp({
    env,
    db,
    rateLimiter,
    redis: valkeyClient,
    natsConnection,
  });

  await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
  app.log.info({ port: env.HTTP_PORT, service: 'chat-svc' }, 'chat-svc started');

  // 5. Start To-Device Purge Janitor (hourly cleanup of >30d messages)
  const purgeJob = new ToDevicePurgeJob({
    pool,
    valkey: valkeyClient,
    retentionDays: 30,
    intervalMs: parseDurationMs(env.TO_DEVICE_PURGE_INTERVAL),
    logger: app.log,
  });
  purgeJob.start();

  // 6. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Graceful shutdown initiated');

    purgeJob.stop();
    await app.close();

    if (natsConnection) {
      await natsConnection.drain().catch(() => {});
      await natsConnection.close().catch(() => {});
    }

    await rateLimiter.close();
    await closeDb();

    app.log.info('Graceful shutdown completed');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error starting chat-svc:', err);
  process.exit(1);
});
