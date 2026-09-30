import fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { ProblemError } from './errors/problem.js';
import { healthRoute } from './routes/health.js';
import { ticketRoute } from './routes/ticket.js';
import { getEnv, type Env } from './config/env.js';
import { TicketStore, type TicketPayload } from './tickets/ticket-store.js';
import { ValkeyRateLimiter, type RateLimiter } from './rate-limit/valkey-limiter.js';
import { ConnectionManager, type ConnectionMeta } from './websocket/connection-manager.js';
import { VideoClient } from './video/video-client.js';
import type { Redis } from 'ioredis';
import type { NatsConnection } from 'nats';
import type { RealtimeEventConsumer } from './nats/consumer.js';
import { type RevocationSweeper, realtimeRegistry } from './revocation/revocation-sweeper.js';
import { metricsPlugin, type Registry } from '@winkey/metrics';

export interface BuildAppOptions {
  env?: Env;
  ticketStore?: TicketStore;
  connectionManager?: ConnectionManager;
  videoClient?: VideoClient;
  rateLimiter?: RateLimiter;
  redis?: Redis | null;
  natsConnection?: NatsConnection | null;
  eventConsumer?: RealtimeEventConsumer | null;
  revocationSweeper?: RevocationSweeper | null;
  metricsRegistry?: Registry;
}

export interface RealtimeServer {
  app: FastifyInstance;
  wss: WebSocketServer;
  connectionManager: ConnectionManager;
  ticketStore: TicketStore;
  revocationSweeper?: RevocationSweeper | null;
  setShuttingDown: (val: boolean) => void;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<RealtimeServer> {
  const env = options.env || getEnv();
  const ticketStore = options.ticketStore || new TicketStore(options.redis ?? null);
  const videoClient = options.videoClient || new VideoClient(env.VIDEO_SVC_URL);
  const connectionManager =
    options.connectionManager ||
    new ConnectionManager({
      videoClient,
      heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: env.HEARTBEAT_TIMEOUT_MS,
    });
  const rateLimiter = options.rateLimiter || new ValkeyRateLimiter(env.VALKEY_URL, options.redis);

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
          'ticket',
          'body.ticket',
          'query.ticket',
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

  // Register HTTP routes
  // Register Prometheus /metrics & HTTP request telemetry
  await app.register(metricsPlugin, {
    registry: options.metricsRegistry ?? realtimeRegistry,
  });

  await app.register(healthRoute, {
    redis: options.redis,
    natsConnection: options.natsConnection,
    eventConsumer: options.eventConsumer,
  });

  await app.register(ticketRoute, {
    ticketStore,
    rateLimiter,
  });

  // Non-upgrade HTTP GET /v1/realtime handler
  app.get('/v1/realtime', async (request, _reply) => {
    const upgradeHeader = request.headers.upgrade;
    if (typeof upgradeHeader !== 'string' || upgradeHeader.toLowerCase() !== 'websocket') {
      throw ProblemError.badRequest('WebSocket upgrade required (Upgrade: websocket)');
    }
  });

  let isShuttingDown = false;

  // Setup WebSocket Server for HTTP upgrade
  // Hard cap well above the 4 KiB contract limit; frames 4 KiB–64 KiB get BAD_MESSAGE in handleClientFrame.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  app.server.on('upgrade', async (req, socket, head) => {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);

    if (url.pathname !== '/v1/realtime') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (isShuttingDown) {
      const problemJson = JSON.stringify({
        type: 'https://winkey.vn/problems/service-unavailable',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Server is shutting down',
        code: 'SERVICE_UNAVAILABLE',
      });
      socket.write(
        'HTTP/1.1 503 Service Unavailable\r\n' +
          'Content-Type: application/problem+json\r\n' +
          `Content-Length: ${Buffer.byteLength(problemJson)}\r\n` +
          'Connection: close\r\n\r\n' +
          problemJson,
      );
      socket.destroy();
      return;
    }

    let userMeta: ConnectionMeta = { userId: null, roles: [] };

    if (url.searchParams.has('ticket')) {
      const ticket = url.searchParams.get('ticket') || '';
      if (!ticket) {
        const problemJson = JSON.stringify({
          type: 'https://winkey.vn/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Invalid, expired, or already used ticket',
          code: 'UNAUTHORIZED',
        });
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\n' +
            'Content-Type: application/problem+json\r\n' +
            `Content-Length: ${Buffer.byteLength(problemJson)}\r\n` +
            'Connection: close\r\n\r\n' +
            problemJson,
        );
        socket.destroy();
        return;
      }

      // Validate & redeem ticket BEFORE upgrade
      let redeemed: TicketPayload | null = null;
      try {
        redeemed = await ticketStore.redeemTicket(ticket);
      } catch (err) {
        if (err instanceof ProblemError && err.status === 503) {
          const problemJson = JSON.stringify(err.toProblemDocument());
          socket.write(
            'HTTP/1.1 503 Service Unavailable\r\n' +
              'Content-Type: application/problem+json\r\n' +
              `Content-Length: ${Buffer.byteLength(problemJson)}\r\n` +
              'Connection: close\r\n\r\n' +
              problemJson,
          );
          socket.destroy();
          return;
        }
        throw err;
      }

      if (!redeemed) {
        const problemJson = JSON.stringify({
          type: 'https://winkey.vn/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Invalid, expired, or already used ticket',
          code: 'UNAUTHORIZED',
        });
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\n' +
            'Content-Type: application/problem+json\r\n' +
            `Content-Length: ${Buffer.byteLength(problemJson)}\r\n` +
            'Connection: close\r\n\r\n' +
            problemJson,
        );
        socket.destroy();
        return;
      }

      userMeta = {
        userId: redeemed.user_id,
        roles: redeemed.roles,
        authenticatedAt: Math.floor(Date.now() / 1000),
      };
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      connectionManager.handleNewConnection(ws, userMeta);
    });
  });

  app.addHook('onClose', async () => {
    isShuttingDown = true;
    if (options.revocationSweeper) {
      options.revocationSweeper.stop();
    }
    await connectionManager.closeAll(1001, 'Server shutting down');
    wss.close();
  });

  return {
    app,
    wss,
    connectionManager,
    ticketStore,
    revocationSweeper: options.revocationSweeper,
    setShuttingDown: (val: boolean) => {
      isShuttingDown = val;
    },
  };
}
