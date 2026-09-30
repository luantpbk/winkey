import fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { ProblemError } from './errors/problem.js';
import { registerRoute } from './routes/register.js';
import { loginRoute } from './routes/login.js';
import { refreshRoute } from './routes/refresh.js';
import { logoutRoute } from './routes/logout.js';
import { meRoute } from './routes/me.js';
import { verifyRoute } from './routes/verify.js';
import { jwksRoute } from './routes/jwks.js';
import { usersRoute } from './routes/users.js';
import { oauthRoute, type GoogleTokenExchanger } from './routes/oauth.js';
import { healthRoute } from './routes/health.js';
import { adminRoute } from './routes/admin.js';
import { getEnv, type Env } from './config/env.js';
import { getDb } from './db/client.js';
import { ValkeyRateLimiter, type RateLimiter } from './rate-limit/valkey-limiter.js';
import type { Database } from './db/types.js';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { NatsConnection } from 'nats';

export interface BuildAppOptions {
  env?: Env;
  db?: Kysely<Database>;
  rateLimiter?: RateLimiter;
  redis?: Redis | null;
  natsConnection?: NatsConnection | null;
  googleTokenExchanger?: GoogleTokenExchanger;
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
          'body.password',
          'body.current_password',
          'body.new_password',
          'body.confirm_handle',
          'body.email',
          'body.reason',
          'password',
          'current_password',
          'new_password',
          'confirm_handle',
          'email',
          'reason',
          'suspension_reason',
          'access_token',
          'refresh_token',
        ],
        censor: '[REDACTED]',
      },
    },
  });

  // Register cookie parser
  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
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

  // Register routes
  await app.register(registerRoute, { db, env, rateLimiter });
  await app.register(loginRoute, { db, env, rateLimiter });
  await app.register(refreshRoute, { db, env });
  await app.register(logoutRoute, { db, env });
  await app.register(meRoute, { db, env, rateLimiter });
  await app.register(verifyRoute, { env });
  await app.register(jwksRoute, { env });
  await app.register(usersRoute, { db, env });
  await app.register(oauthRoute, { db, env, tokenExchanger: options.googleTokenExchanger });
  await app.register(adminRoute, { db, env });
  await app.register(healthRoute, {
    db,
    redis: options.redis,
    natsConnection: options.natsConnection,
  });

  return app;
}
