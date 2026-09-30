import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Registry } from 'prom-client';

/**
 * Creates a Fastify route handler serving the Prometheus exposition format
 * from the provided registry.
 */
export function createMetricsHandler(registry: Registry) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const metrics = await registry.metrics();
    reply.header('Content-Type', registry.contentType);
    return reply.status(200).send(metrics);
  };
}
