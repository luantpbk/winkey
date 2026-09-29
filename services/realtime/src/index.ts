import { connect as connectNats, type NatsConnection } from 'nats';
import { Redis } from 'ioredis';
import { getEnv } from './config/env.js';
import { buildApp } from './server.js';
import { TicketStore } from './tickets/ticket-store.js';
import { VideoClient } from './video/video-client.js';
import { ConnectionManager } from './websocket/connection-manager.js';
import { RealtimeEventConsumer } from './nats/consumer.js';

async function main(): Promise<void> {
  const env = getEnv();
  console.log(
    JSON.stringify({
      msg: 'Starting realtime-gw service...',
      env: env.NODE_ENV,
      port: env.HTTP_PORT,
    }),
  );

  // 1. Connect to NATS
  let natsConnection: NatsConnection | null = null;
  try {
    natsConnection = await connectNats({ servers: env.NATS_URL });
    console.log(JSON.stringify({ msg: 'Connected to NATS', url: env.NATS_URL }));
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'Warning: Could not connect to NATS on startup', err }));
  }

  // 2. Connect to Valkey / Redis
  let valkeyClient: Redis | null = null;
  try {
    valkeyClient = new Redis(env.VALKEY_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    console.log(JSON.stringify({ msg: 'Connected to Valkey', url: env.VALKEY_URL }));
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'Warning: Could not connect to Valkey on startup', err }));
  }

  // 3. Components
  const ticketStore = new TicketStore(env.VALKEY_URL, valkeyClient);
  const videoClient = new VideoClient(env.VIDEO_SVC_URL);
  const connectionManager = new ConnectionManager({
    videoClient,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: env.HEARTBEAT_TIMEOUT_MS,
  });

  // 4. Start NATS Consumer if NATS is available
  let eventConsumer: RealtimeEventConsumer | null = null;
  if (natsConnection) {
    eventConsumer = new RealtimeEventConsumer({
      nats: natsConnection,
      connectionManager,
    });
    await eventConsumer.start();
  }

  // 5. Build and listen HTTP app + WebSocket upgrade
  const { app } = await buildApp({
    env,
    ticketStore,
    connectionManager,
    videoClient,
    redis: valkeyClient,
    natsConnection,
  });

  await app.listen({ port: env.HTTP_PORT, host: '0.0.0.0' });
  console.log(JSON.stringify({ msg: `realtime-gw listening on port ${env.HTTP_PORT}` }));

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(
      JSON.stringify({ msg: `Received ${signal}, shutting down gracefully within 10s...` }),
    );

    // Stop accepting new NATS events
    if (eventConsumer) {
      await eventConsumer.stop().catch(() => {});
    }

    // Close all active WebSocket connections with code 1001 (Server shutting down)
    await connectionManager.closeAll(1001, 'Server shutting down');

    // Close HTTP server
    await app.close().catch(() => {});

    // Close connections
    if (natsConnection) {
      await natsConnection.drain().catch(() => {});
      await natsConnection.close().catch(() => {});
    }
    if (valkeyClient) {
      await valkeyClient.quit().catch(() => {});
    }

    console.log(JSON.stringify({ msg: 'realtime-gw stopped cleanly' }));
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
