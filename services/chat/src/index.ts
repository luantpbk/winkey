import { Redis } from 'ioredis';
import { loadEnv } from './config/env.js';
import { getDb, closeDb } from './db/client.js';
import { ValkeyRateLimiter } from './rate-limit/valkey-limiter.js';
import { ToDevicePurgeJob } from './janitor/to-device-purge-job.js';
import { buildApp } from './server.js';
import { createLogger, sanitizeEndpointUrl } from './infra/logger.js';
import { ManagedNatsConnection } from './realtime/nats-manager.js';
import { AttachmentsJanitor } from './janitor/attachments-janitor.js';
import { createAttachmentStorage } from './storage/attachment-storage.js';
import { parseDurationMs } from './utils/duration.js';

async function main() {
  const env = loadEnv();
  const logger = createLogger();

  logger.info(
    {
      env: env.NODE_ENV,
      port: env.HTTP_PORT,
      database: sanitizeEndpointUrl(env.DATABASE_URL),
      valkey: sanitizeEndpointUrl(env.VALKEY_URL),
      nats: sanitizeEndpointUrl(env.NATS_URL),
      chat_s3: sanitizeEndpointUrl(env.CHAT_S3_ENDPOINT),
    },
    'Starting chat-svc...',
  );

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
    logger.warn(
      { err, valkey: sanitizeEndpointUrl(env.VALKEY_URL) },
      'Could not connect to Valkey on startup',
    );
  }

  const rateLimiter = new ValkeyRateLimiter(env.VALKEY_URL, valkeyClient ?? undefined);

  // 3. Connect to NATS with auto-recovery and readiness tracking
  const natsManager = new ManagedNatsConnection(env.NATS_URL, logger);
  const natsInitialConnect = natsManager.start();

  // Allow up to 250ms for initial NATS connection so /readyz is green immediately if NATS is up;
  // if NATS is down at boot, waitOnFirstConnect continues in the background and /readyz serves 503.
  await Promise.race([natsInitialConnect, new Promise((resolve) => setTimeout(resolve, 250))]);

  // 4. Build and listen HTTP app
  const storage = createAttachmentStorage(env);
  if (!storage) {
    logger.warn({}, 'CHAT_S3_* not set: attachment endpoints answer 503');
  }
  const app = await buildApp({
    storage,
    env,
    db,
    rateLimiter,
    redis: valkeyClient,
    getNatsStatus: () => natsManager.getReadinessState(),
    getNatsConnection: () => natsManager.getConnection(),
    natsConfigured: Boolean(env.NATS_URL),
    loggerInstance: logger,
  });

  await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
  logger.info({ port: env.HTTP_PORT, service: 'chat-svc' }, 'chat-svc started');

  // 5. Start To-Device Purge Janitor (hourly cleanup of >30d messages)
  const purgeJob = new ToDevicePurgeJob({
    pool,
    valkey: valkeyClient,
    retentionDays: 30,
    intervalMs: parseDurationMs(env.TO_DEVICE_PURGE_INTERVAL),
    logger,
  });
  purgeJob.start();

  // 5b. SOC-3b attachments janitor (expired and never-sent attachments), only when the bucket is configured
  const attachmentsJanitor = storage
    ? new AttachmentsJanitor({
        pool,
        storage,
        valkey: valkeyClient,
        intervalMs: parseDurationMs(env.ATTACHMENT_JANITOR_INTERVAL),
        logger,
      })
    : null;
  attachmentsJanitor?.start();

  // 6. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Graceful shutdown initiated');

    purgeJob.stop();
    attachmentsJanitor?.stop();
    await app.close();
    await natsManager.close();
    await rateLimiter.close();
    await closeDb();

    logger.info('Graceful shutdown completed');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  const fallbackLogger = createLogger();
  fallbackLogger.fatal({ err }, 'Fatal error starting chat-svc');
  process.exit(1);
});
