import fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ProblemError } from './errors/problem.js';
import { loadEnv, type Env } from './config/env.js';
import { getDb } from './db/client.js';
import { ValkeyRateLimiter, type RateLimiter } from './rate-limit/valkey-limiter.js';
import { RealtimeHintDispatcher } from './realtime/hints.js';
import { healthRoute } from './routes/health.js';
import { devicesRoute } from './routes/devices.js';
import { toDeviceRoute } from './routes/to-device.js';
import { conversationsRoute } from './routes/conversations.js';
import { messagesRoute } from './routes/messages.js';
import { attachmentsRoute } from './routes/attachments.js';
import { keyBackupRoute } from './routes/key-backup.js';
import { createAttachmentStorage, type AttachmentStorage } from './storage/attachment-storage.js';
import { parseDurationMs } from './utils/duration.js';
import { REDACT_PATHS } from './infra/logger.js';
import type { Database } from './db/types.js';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { NatsConnection } from 'nats';
import { metricsPlugin, type Registry } from '@winkey/metrics';
import { chatRegistry } from './metrics.js';

export interface BuildAppOptions {
  env?: Env;
  db?: Kysely<Database>;
  rateLimiter?: RateLimiter;
  redis?: Redis | null;
  natsConnection?: NatsConnection | null;
  natsConfigured?: boolean;
  getNatsStatus?: () => 'ok' | 'disconnected' | 'skipped';
  getNatsConnection?: () => NatsConnection | null;
  metricsRegistry?: Registry;
  loggerInstance?: FastifyServerOptions['loggerInstance'];
  /** SOC-3b ciphertext store; defaults to the CHAT_S3_* env (null when unset: attachment endpoints answer 503). */
  storage?: AttachmentStorage | null;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env || loadEnv();
  const db = options.db || getDb(env.DATABASE_URL).db;
  const rateLimiter =
    options.rateLimiter || new ValkeyRateLimiter(env.VALKEY_URL, options.redis ?? undefined);
  const natsSource =
    options.getNatsConnection ?? (options.natsConnection ? () => options.natsConnection! : null);
  const hints = new RealtimeHintDispatcher(natsSource ?? options.natsConnection ?? null);
  const storage = options.storage !== undefined ? options.storage : createAttachmentStorage(env);

  const trustProxyConfig = env.TRUST_PROXY_CIDRS
    ? env.TRUST_PROXY_CIDRS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : false;

  const app = fastify({
    trustProxy: trustProxyConfig,
    ...(options.loggerInstance
      ? { loggerInstance: options.loggerInstance }
      : {
          logger: {
            level: env.NODE_ENV === 'test' ? 'silent' : 'info',
            redact: {
              paths: REDACT_PATHS,
              censor: '[REDACTED]',
            },
          },
        }),
  });

  // RFC 9457 Problem Details custom error handler
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ProblemError) {
      if (error.headers) {
        for (const [header, val] of Object.entries(error.headers)) {
          reply.header(header, val);
        }
      }
      return reply
        .status(error.status)
        .type('application/problem+json')
        .send(error.toProblemDocument(request.url));
    }

    request.log.error({ err: error }, 'Unhandled server error');

    const err = (error || {}) as { statusCode?: number; name?: string; message?: string };
    const status = err.statusCode || 500;
    return reply
      .status(status)
      .type('application/problem+json')
      .send({
        type: `https://winkey.vn/problems/${status}`,
        title: err.name || 'Internal Server Error',
        status,
        detail:
          env.NODE_ENV === 'production'
            ? 'An unexpected error occurred'
            : err.message || 'Unknown error',
        code: 'INTERNAL_SERVER_ERROR',
        instance: request.url,
      });
  });

  // Register Prometheus /metrics & HTTP request telemetry
  await app.register(metricsPlugin, {
    registry: options.metricsRegistry ?? chatRegistry,
  });

  // Register routes
  const natsConfigured =
    options.natsConfigured !== undefined ? options.natsConfigured : Boolean(env.NATS_URL);

  await app.register(healthRoute, {
    db,
    redis: options.redis,
    natsConnection: options.natsConnection,
    natsConfigured,
    getNatsStatus: options.getNatsStatus,
  });
  await app.register(devicesRoute, { db, hints, rateLimiter });
  await app.register(toDeviceRoute, { db, hints, rateLimiter });
  await app.register(conversationsRoute, { db, hints, rateLimiter });
  await app.register(messagesRoute, { db, hints, rateLimiter, storage });
  await app.register(attachmentsRoute, {
    db,
    storage,
    rateLimiter,
    attachmentTtlMs: parseDurationMs(env.CHAT_ATTACHMENT_TTL, 30 * 24 * 60 * 60 * 1000),
  });
  await app.register(keyBackupRoute, { db, rateLimiter });

  return app;
}
