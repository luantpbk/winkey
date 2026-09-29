import type { FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import type { NatsConnection } from 'nats';
import type { RealtimeEventConsumer } from '../nats/consumer.js';

export interface HealthCheckDependencies {
  redis?: Redis | null;
  natsConnection?: NatsConnection | null;
  eventConsumer?: RealtimeEventConsumer | null;
}

export const healthRoute: FastifyPluginAsync<HealthCheckDependencies> = async (
  fastify,
  { redis, natsConnection, eventConsumer },
) => {
  fastify.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  fastify.get('/readyz', async (_request, reply) => {
    const checks: Record<string, string> = {
      valkey: 'unknown',
      nats: 'unknown',
      consumer: 'unknown',
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

    // Check NATS connection
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

    // Check JetStream consumers readiness (VIDEO and SOCIAL consumers must both be active)
    if (eventConsumer) {
      const consumerReady = eventConsumer.isReady();
      checks.consumer = consumerReady ? 'ok' : 'degraded';
      if (!consumerReady) {
        isHealthy = false;
      }
    } else {
      checks.consumer = 'skipped';
    }

    const statusCode = isHealthy ? 200 : 503;
    return reply.status(statusCode).send({
      status: isHealthy ? 'ok' : 'degraded',
      checks,
    });
  });
};
