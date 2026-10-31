import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { ProblemError } from '../errors/problem.js';
import { requireAuth } from '../utils/auth.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildTurnCredentialsRateLimitKey } from '../rate-limit/valkey-limiter.js';

export interface TurnConfig {
  secret: string;
  urls: string[];
  ttlSeconds: number;
}

export interface CallsRouteDependencies {
  turn: TurnConfig | null;
  rateLimiter?: RateLimiter;
  now?: () => number;
}

/**
 * coturn REST API (`use-auth-secret`): username `<expiry unix seconds>:<user id>`, credential
 * base64(HMAC-SHA1(secret, username)). coturn recomputes the same HMAC and rejects expired usernames.
 */
export function turnCredential(secret: string, username: string): string {
  return crypto.createHmac('sha1', secret).update(username).digest('base64');
}

/** TURN_SECRET + TURN_URLS (comma-separated `turn:`/`turns:`/`stun:` URLs) or null when not configured. */
export function parseTurnConfig(env: {
  TURN_SECRET?: string;
  TURN_URLS?: string;
  TURN_TTL_SECONDS: number;
}): TurnConfig | null {
  const urls = (env.TURN_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^(turns?|stuns?):/.test(u));
  if (!env.TURN_SECRET || urls.length === 0) return null;
  return { secret: env.TURN_SECRET, urls, ttlSeconds: env.TURN_TTL_SECONDS };
}

export const callsRoute: FastifyPluginAsync<CallsRouteDependencies> = async (
  fastify,
  { turn, rateLimiter, now = Date.now },
) => {
  // getTurnCredentials (SOC-4a). The credential is a secret: it is never logged (logger REDACT_PATHS).
  fastify.post('/v1/chat/calls/turn-credentials', async (request, reply) => {
    const caller = requireAuth(request);
    if (!turn) {
      throw ProblemError.serviceUnavailable(
        'Calls are not configured on this server',
        'TURN_UNAVAILABLE',
      );
    }
    if (rateLimiter) {
      await rateLimiter.consume({
        key: buildTurnCredentialsRateLimitKey(caller.userId),
        limit: 30,
        windowSeconds: 3600,
      });
    }
    const expiresAt = Math.floor(now() / 1000) + turn.ttlSeconds;
    const username = `${expiresAt}:${caller.userId}`;
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send({
      urls: turn.urls,
      username,
      credential: turnCredential(turn.secret, username),
      ttl_seconds: turn.ttlSeconds,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    });
  });
};
