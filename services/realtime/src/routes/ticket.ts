import type { FastifyPluginAsync } from 'fastify';
import { ProblemError } from '../errors/problem.js';
import type { TicketStore } from '../tickets/ticket-store.js';
import { type RateLimiter, buildTicketRateLimitKey } from '../rate-limit/valkey-limiter.js';

export interface TicketRouteDependencies {
  ticketStore: TicketStore;
  rateLimiter?: RateLimiter;
}

export const ticketRoute: FastifyPluginAsync<TicketRouteDependencies> = async (
  fastify,
  { ticketStore, rateLimiter },
) => {
  fastify.post('/v1/realtime/ticket', async (request, reply) => {
    // 1. Identity from gateway headers only (ADR-009)
    const userId = request.headers['x-user-id'];
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw ProblemError.unauthorized('Authentication required to issue realtime ticket');
    }

    const rawRoles = request.headers['x-user-roles'];
    const roles =
      typeof rawRoles === 'string'
        ? rawRoles
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
        : Array.isArray(rawRoles)
          ? rawRoles
          : [];

    // 2. Rate limit: 30/min per user
    if (rateLimiter) {
      await rateLimiter.consume({
        key: buildTicketRateLimitKey(userId.trim()),
        limit: 30,
        windowSeconds: 60,
      });
    }

    // 3. Issue ticket (never logged)
    const issued = await ticketStore.issueTicket(userId.trim(), roles);

    // 4. Return 201 with Cache-Control: no-store
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send({
      ticket: issued.ticket,
      expires_at: issued.expires_at,
    });
  });
};
