import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import { buildApp, type RealtimeServer } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { TicketStore } from '../../src/tickets/ticket-store.js';
import { VideoClient } from '../../src/video/video-client.js';
import { ConnectionManager } from '../../src/websocket/connection-manager.js';
import {
  RevocationSweeper,
  resetRevocationMetricsForTest,
  getRevocationMetricCount,
} from '../../src/revocation/revocation-sweeper.js';

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      return resolve({ code: 1000, reason: '' });
    }
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), timeoutMs);
    ws.once('close', (code, reasonBuf) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString('utf-8') });
    });
  });
}

describe('Real Valkey Revocation Integration Tests (Task A5)', () => {
  let valkeyUrl: string | null = null;
  let stopValkeyContainer: (() => Promise<void>) | null = null;
  let redis: Redis | null = null;
  let isReady = false;

  let server: RealtimeServer | null = null;
  let serverPort = 0;
  let sweeper: RevocationSweeper | null = null;
  let ticketStore: TicketStore | null = null;

  beforeEach((ctx) => {
    if (!isReady) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail('Real Valkey container required by WINKEY_REQUIRE_DOCKER=1 but unavailable');
      }
      ctx.skip();
    }
    resetRevocationMetricsForTest();
  });

  beforeAll(async () => {
    valkeyUrl =
      process.env.TEST_VALKEY_URL ||
      (process.env.VALKEY_URL && !process.env.VALKEY_URL.includes('localhost:6379')
        ? process.env.VALKEY_URL
        : null);

    if (!valkeyUrl) {
      try {
        const { GenericContainer } = await import('testcontainers');
        const container = await new GenericContainer('redis:7-alpine')
          .withExposedPorts(6379)
          .start();
        const port = container.getMappedPort(6379);
        const host = container.getHost();
        valkeyUrl = `redis://${host}:${port}`;
        stopValkeyContainer = async () => {
          await container.stop();
        };
      } catch {
        // Docker unavailable
      }
    }

    if (!valkeyUrl) return;

    try {
      redis = new Redis(valkeyUrl);
      await redis.ping();

      const env = getEnv({
        NODE_ENV: 'test',
        VALKEY_URL: valkeyUrl,
        REVOCATION_SWEEP_MS: 30000,
      });

      ticketStore = new TicketStore(redis);
      const videoClient = new VideoClient('http://localhost:8080');
      const connectionManager = new ConnectionManager({
        videoClient,
        heartbeatIntervalMs: 25000,
        heartbeatTimeoutMs: 60000,
      });

      sweeper = new RevocationSweeper({
        redis,
        connectionManager,
        sweepIntervalMs: 30000,
      });

      server = await buildApp({
        env,
        ticketStore,
        connectionManager,
        videoClient,
        redis,
        revocationSweeper: sweeper,
      });

      await server.app.listen({ port: 0, host: '127.0.0.1' });
      const addr = server.app.server.address();
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      isReady = true;
    } catch (err) {
      console.error('Failed to initialize test suite with Valkey:', err);
    }
  }, 120_000);

  afterAll(async () => {
    if (server) {
      await server.app.close();
    }
    if (redis) {
      await redis.quit().catch(() => {});
    }
    if (stopValkeyContainer) {
      await stopValkeyContainer();
    }
  });

  it('user connects -> auth-svc cutoff written -> socket closed with 4401 within one sweep; user 2 stays open', async () => {
    if (!isReady || !redis || !ticketStore || !sweeper) return;

    const user1Id = 'usr_019234567890abcdef11111111';
    const user2Id = 'usr_019234567890abcdef22222222';

    // 1. User 1 connects with a valid ticket
    const ticket1 = await ticketStore.issueTicket(user1Id, ['user']);
    const ws1 = new WebSocket(`ws://127.0.0.1:${serverPort}/v1/realtime?ticket=${ticket1.ticket}`);
    await waitForOpen(ws1);

    // 2. User 2 connects with a valid ticket
    const ticket2 = await ticketStore.issueTicket(user2Id, ['user']);
    const ws2 = new WebSocket(`ws://127.0.0.1:${serverPort}/v1/realtime?ticket=${ticket2.ticket}`);
    await waitForOpen(ws2);

    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    // 3. auth-svc writes user revocation cutoff key: auth:revoked:user:{userId}
    const currentUnix = Math.floor(Date.now() / 1000);
    // Write cutoff = currentUnix (matching or following token/ticket issue timestamp)
    await redis.set(`auth:revoked:user:${user1Id}`, String(currentUnix), 'EX', 960);

    // 4. Trigger sweeper
    const closePromise1 = waitForClose(ws1);
    const sweepResult = await sweeper.sweep();

    expect(sweepResult.checkedUsers).toBe(2);
    expect(sweepResult.closedSockets).toBe(1);

    // Socket 1 receives close event with 4401 and 'session revoked'
    const closeEvt = await closePromise1;
    expect(closeEvt.code).toBe(4401);
    expect(closeEvt.reason).toBe('session revoked');
    expect(getRevocationMetricCount('realtime_revoked_closes_total')).toBe(1);

    // Socket 2 stays open
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws2.close();
  });

  it('allows a fresh ticket after the cutoff to connect and stay open', async () => {
    if (!isReady || !redis || !ticketStore || !sweeper) return;

    const userId = 'usr_019234567890abcdef33333333';

    // Revocation cutoff set in past
    const cutoffUnix = Math.floor(Date.now() / 1000);
    await redis.set(`auth:revoked:user:${userId}`, String(cutoffUnix), 'EX', 960);

    // Wait until current unix second is strictly greater than cutoffUnix
    await new Promise((r) => setTimeout(r, 1100));

    // User gets new role and fresh ticket issued AFTER cutoff
    const freshTicket = await ticketStore.issueTicket(userId, ['user']);
    const ws = new WebSocket(
      `ws://127.0.0.1:${serverPort}/v1/realtime?ticket=${freshTicket.ticket}`,
    );
    await waitForOpen(ws);

    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Run sweep: fresh ticket has authenticatedAt > cutoff -> stays open!
    const sweepResult = await sweeper.sweep();
    expect(sweepResult.closedSockets).toBe(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });

  it('fails open when Valkey is stopped: sockets stay open and error metric increments', async () => {
    if (!isReady || !ticketStore || !sweeper) return;

    const userFailOpenId = 'usr_019234567890abcdef44444444';
    const ticket = await ticketStore.issueTicket(userFailOpenId, ['user']);
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/v1/realtime?ticket=${ticket.ticket}`);
    await waitForOpen(ws);

    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Disconnect Redis or simulate unreachable Valkey
    const brokenRedis = new Redis('redis://127.0.0.1:59999', {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 50,
      lazyConnect: true,
    });

    sweeper.setRedis(brokenRedis);

    // Trigger sweep with broken Valkey
    const sweepResult = await sweeper.sweep();
    expect(sweepResult.error).toBe(true);

    // Sockets stay open (fail-open)
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(getRevocationMetricCount('realtime_revocation_sweep_errors_total')).toBe(1);

    // Restore real redis
    sweeper.setRedis(redis);
    brokenRedis.disconnect();
    ws.close();
  });
});
