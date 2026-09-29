import type { FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import type { NatsConnection } from 'nats';

export interface HealthCheckDependencies {
  redis?: Redis | null;
  natsConnection?: NatsConnection | null;
}

export const healthRoute: FastifyPluginAsync<HealthCheckDependencies> = async (
  fastify,
  { redis, natsConnection },
) => {
  fastify.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  fastify.get('/readyz', async (_request, reply) => {
    const checks: Record<string, string> = {
      valkey: 'unknown',
      nats: 'unknown',
    };
    let isHealthy = true;

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

    // Check NATS JetStream
    if (natsConnection) {
      try {
        if (!natsConnection.isClosed()) {
          const js = natsConnection.jetstream();
          if (js) {
            checks.nats = 'ok';
          } else {
            checks.nats = 'no-jetstream';
            isHealthy = false;
          }
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
