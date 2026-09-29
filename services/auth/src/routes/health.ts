import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';

export interface HealthCheckDependencies {
  db?: Kysely<Database>;
  redis?: any;
  natsConnection?: any;
}

export const healthRoute: FastifyPluginAsync<HealthCheckDependencies> = async (
  fastify,
  { db, redis, natsConnection },
) => {
  fastify.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  fastify.get('/readyz', async (_request, reply) => {
    const checks: Record<string, string> = {
      db: 'unknown',
      valkey: 'unknown',
      nats: 'unknown',
    };
    let isHealthy = true;

    // Check DB
    if (db) {
      try {
        await sql`SELECT 1`.execute(db);
        checks.db = 'ok';
      } catch {
        checks.db = 'error';
        isHealthy = false;
      }
    } else {
      checks.db = 'skipped';
    }

    // Check Valkey / Redis
    if (redis) {
      try {
        const ping = await redis.ping();
        checks.valkey = ping === 'PONG' ? 'ok' : 'degraded';
        if (checks.valkey !== 'ok') isHealthy = false;
      } catch {
        checks.valkey = 'error';
        isHealthy = false;
      }
    } else {
      checks.valkey = 'skipped';
    }

    // Check NATS
    if (natsConnection) {
      try {
        if (!natsConnection.isClosed()) {
          checks.nats = 'ok';
        } else {
          checks.nats = 'closed';
          isHealthy = false;
        }
      } catch {
        checks.nats = 'error';
        isHealthy = false;
      }
    } else {
      checks.nats = 'skipped';
    }

    const statusCode = isHealthy ? 200 : 503;
    return reply.status(statusCode).send({
      status: isHealthy ? 'ok' : 'degraded',
      checks,
    });
  });
};
