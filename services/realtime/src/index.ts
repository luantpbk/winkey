import { connect as connectNats } from 'nats';
import { natsOptionsFromUrl } from '@winkey/outbox/nats';
import { Redis } from 'ioredis';
import pino from 'pino';
import { getEnv } from './config/env.js';
import { buildApp } from './server.js';
import { TicketStore } from './tickets/ticket-store.js';
import { VideoClient } from './video/video-client.js';
import { ConnectionManager } from './websocket/connection-manager.js';
import { RealtimeEventConsumer } from './nats/consumer.js';

async function main(): Promise<void> {
  const env = getEnv();
  const logger = pino({ level: env.NODE_ENV === 'test' ? 'silent' : 'info' });

  logger.info({ env: env.NODE_ENV, port: env.HTTP_PORT }, 'Starting realtime-gw service...');

  // 1. Connect to NATS (fail fast so k8s restarts pod if NATS unavailable)
  const natsConnection = await connectNats({
    ...natsOptionsFromUrl(env.NATS_URL),
    name: 'realtime-gw',
  });
  logger.info('Connected to NATS');

  // 2. Connect to Valkey / Redis
  const valkeyClient = new Redis(env.VALKEY_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  logger.info('Connected to Valkey');

  // 3. Components
  const ticketStore = new TicketStore(valkeyClient);
  const videoClient = new VideoClient(env.VIDEO_SVC_URL);
  const connectionManager = new ConnectionManager({
    videoClient,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: env.HEARTBEAT_TIMEOUT_MS,
    logger,
  });

  // 4. Start NATS Consumer
  const eventConsumer = new RealtimeEventConsumer({
    nats: natsConnection,
    connectionManager,
    logger,
  });
  await eventConsumer.start();

  // 5. Build and listen HTTP app + WebSocket upgrade
  const realtimeServer = await buildApp({
    env,
    ticketStore,
    connectionManager,
    videoClient,
    redis: valkeyClient,
    natsConnection,
    eventConsumer,
  });
  const { app } = realtimeServer;

  await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
  logger.info({ port: env.HTTP_PORT }, 'realtime-gw listening');

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received signal, shutting down gracefully within 10s...');
    realtimeServer.setShuttingDown(true);

    // Stop accepting new NATS events
    await eventConsumer.stop().catch(() => {});

    // Close all active WebSocket connections with code 1001 (Server shutting down)
    await connectionManager.closeAll(1001, 'Server shutting down');

    // Close HTTP server
    await app.close().catch(() => {});

    // Close connections
    await natsConnection.drain().catch(() => {});
    await natsConnection.close().catch(() => {});
    await valkeyClient.quit().catch(() => {});

    logger.info('realtime-gw stopped cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      msg: 'Fatal error starting realtime-gw',
      err: String(err),
      stack: err?.stack,
    }),
  );
  process.exit(1);
});
