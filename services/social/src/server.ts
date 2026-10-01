import fastify, { type FastifyInstance } from 'fastify';
import { ProblemError } from './errors/problem.js';
import { commentsRoute } from './routes/comments.js';
import { likesRoute } from './routes/likes.js';
import { subscriptionsRoute } from './routes/subscriptions.js';
import { reportsRoute } from './routes/reports.js';
import { notificationsRoute } from './routes/notifications.js';
import { healthRoute } from './routes/health.js';
import { getEnv, type Env } from './config/env.js';
import { getDb } from './db/client.js';
import { ValkeyRateLimiter, type RateLimiter } from './rate-limit/valkey-limiter.js';
import type { Database } from './db/types.js';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { NatsConnection } from 'nats';
import { metricsPlugin, type Registry } from '@winkey/metrics';
import { socialRegistry } from './metrics.js';

export interface BuildAppOptions {
  env?: Env;
  db?: Kysely<Database>;
  rateLimiter?: RateLimiter;
  redis?: Redis | null;
  natsConnection?: NatsConnection | null;
  metricsRegistry?: Registry;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env || getEnv();
  const db = options.db || getDb(env.DATABASE_URL).db;
  const rateLimiter =
    options.rateLimiter || new ValkeyRateLimiter(env.VALKEY_URL, options.redis ?? undefined);

  const trustProxyConfig = env.TRUST_PROXY_CIDRS
    ? env.TRUST_PROXY_CIDRS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : false;

  const app = fastify({
    trustProxy: trustProxyConfig,
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          'headers.cookie',
          'body.body',
          'body.password',
          'body.email',
          'body.note',
          'body.resolution_note',
          'password',
          'email',
          'note',
          'resolution_note',
        ],
        censor: '[REDACTED]',
      },
    },
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
    registry: options.metricsRegistry ?? socialRegistry,
  });

  // Register routes
  await app.register(commentsRoute, { db, env, rateLimiter });
  await app.register(likesRoute, { db, env, rateLimiter });
  await app.register(subscriptionsRoute, { db, env, rateLimiter });
  await app.register(reportsRoute, { db, env, rateLimiter });
  await app.register(notificationsRoute, { db, env });
  await app.register(healthRoute, {
    db,
    redis: options.redis,
    natsConnection: options.natsConnection,
  });

  return app;
}
