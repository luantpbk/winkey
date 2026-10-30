import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { NatsConnection } from 'nats';

export interface HealthCheckDependencies {
  db?: Kysely<Database>;
  redis?: Redis | null;
  natsConnection?: NatsConnection | null;
  natsConfigured?: boolean;
  getNatsStatus?: () => 'ok' | 'disconnected' | 'skipped';
}

export const healthRoute: FastifyPluginAsync<HealthCheckDependencies> = async (
  fastify,
  { db, redis, natsConnection, natsConfigured, getNatsStatus },
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

    // Check Valkey
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
    let natsCheck: string;
    if (getNatsStatus) {
      natsCheck = getNatsStatus();
    } else if (natsConnection) {
      try {
        if (!natsConnection.isClosed()) {
          natsCheck = 'ok';
        } else {
          natsCheck = 'disconnected';
        }
      } catch {
        natsCheck = 'error';
      }
    } else if (natsConfigured) {
      natsCheck = 'disconnected';
    } else {
      checks.nats = 'skipped';
      natsCheck = 'skipped';
    }

    checks.nats = natsCheck;
    if (natsCheck !== 'ok' && natsCheck !== 'skipped') {
      isHealthy = false;
    }

    const statusCode = isHealthy ? 200 : 503;
    return reply.status(statusCode).send({
      status: isHealthy ? 'ready' : 'not_ready',
      checks,
    });
  });
};
