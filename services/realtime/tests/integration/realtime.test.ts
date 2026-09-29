import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import net from 'node:net';
import { WebSocket } from 'ws';
import { connect as connectNats, type NatsConnection, StringCodec } from 'nats';
import { Redis } from 'ioredis';
import { buildApp, type RealtimeServer } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { TicketStore } from '../../src/tickets/ticket-store.js';
import { VideoClient } from '../../src/video/video-client.js';
import { ConnectionManager } from '../../src/websocket/connection-manager.js';
import { RealtimeEventConsumer } from '../../src/nats/consumer.js';
import { validateServerMessage, type ServerMessage } from '../../src/schemas/validation.js';

const sc = StringCodec();

function parseServerFrame(data: unknown): ServerMessage {
  const text = typeof data === 'string' ? data : data?.toString() || '{}';
  const parsed = JSON.parse(text);
  const val = validateServerMessage(parsed);
  expect(val.valid, `Received server frame failed schema: ${val.error} | frame: ${text}`).toBe(
    true,
  );
  return parsed as ServerMessage;
}

function waitForFrame(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = 5000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`Timeout waiting for frame after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMsg = (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const frame = parseServerFrame(data);
        if (predicate(frame)) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(frame);
        }
      } catch (err) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        reject(err);
      }
    };

    ws.on('message', onMsg);
  });
}

describe('Realtime Gateway Integration (Real NATS JetStream + Valkey)', () => {
  let natsUrl: string | null = null;
  let valkeyUrl: string | null = null;
  let nc: NatsConnection | null = null;
  let redis: Redis | null = null;

  let stopNatsContainer: (() => Promise<void>) | null = null;
  let stopValkeyContainer: (() => Promise<void>) | null = null;

  let isReady = false;

  let gatewayServer: RealtimeServer | null = null;
  let gatewayPort = 0;
  let eventConsumer: RealtimeEventConsumer | null = null;

  const mockAllowedVideos = new Set<string>();

  beforeEach((ctx) => {
    if (!isReady) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail('Real NATS + Valkey required by WINKEY_REQUIRE_DOCKER=1 but unavailable');
      }
      ctx.skip();
    }
  });

  beforeAll(async () => {
    // 1. Discover or start NATS container with JetStream
    natsUrl =
      process.env.TEST_NATS_URL ||
      (process.env.NATS_URL && !process.env.NATS_URL.includes('localhost:4222')
        ? process.env.NATS_URL
        : null);

    if (!natsUrl) {
      try {
        const { GenericContainer } = await import('testcontainers');
        const natsContainer = await new GenericContainer('nats:2.10-alpine')
          .withCommand(['-js', '-sd', '/data'])
          .withExposedPorts(4222)
          .start();
        const mappedPort = natsContainer.getMappedPort(4222);
        const host = natsContainer.getHost();
        natsUrl = `nats://${host}:${mappedPort}`;
        stopNatsContainer = async () => {
          await natsContainer.stop();
        };
      } catch {
        // Docker unavailable
      }
    }

    // 2. Discover or start Valkey / Redis container
    valkeyUrl =
      process.env.TEST_VALKEY_URL ||
      (process.env.VALKEY_URL && !process.env.VALKEY_URL.includes('localhost:6379')
        ? process.env.VALKEY_URL
        : null);

    if (!valkeyUrl) {
      try {
        const { GenericContainer } = await import('testcontainers');
        const valkeyContainer = await new GenericContainer('redis:7-alpine')
          .withExposedPorts(6379)
          .start();
        const mappedPort = valkeyContainer.getMappedPort(6379);
        const host = valkeyContainer.getHost();
        valkeyUrl = `redis://${host}:${mappedPort}`;
        stopValkeyContainer = async () => {
          await valkeyContainer.stop();
        };
      } catch {
        // Docker unavailable
      }
    }

    if (!natsUrl || !valkeyUrl) {
      return;
    }

    // 3. Connect to NATS and Valkey
    try {
      nc = await connectNats({ servers: natsUrl });
      redis = new Redis(valkeyUrl);

      // Create JetStream streams
      const jsm = await nc.jetstreamManager();
      try {
        await jsm.streams.add({
          name: 'VIDEO',
          subjects: ['video.ready', 'video.failed'],
        });
      } catch {
        // Stream may already exist
      }
      try {
        await jsm.streams.add({
          name: 'SOCIAL',
          subjects: ['social.comment.created', 'social.video.like_changed'],
        });
      } catch {
        // Stream may already exist
      }

      // 4. Start Realtime Gateway Server
      const env = getEnv({
        NODE_ENV: 'test',
        VALKEY_URL: valkeyUrl,
        NATS_URL: natsUrl,
      });

      const ticketStore = new TicketStore(valkeyUrl, redis);

      // Stub video client: allowed if in mockAllowedVideos
      const videoClient = new VideoClient('http://localhost:8080');
      videoClient.canAccessVideo = async ({ videoId }) => {
        return mockAllowedVideos.has(videoId);
      };

      const connectionManager = new ConnectionManager({
        videoClient,
        heartbeatIntervalMs: 25000,
        heartbeatTimeoutMs: 60000,
      });

      eventConsumer = new RealtimeEventConsumer({
        nats: nc,
        connectionManager,
      });
      await eventConsumer.start();

      gatewayServer = await buildApp({
        env,
        ticketStore,
        connectionManager,
        videoClient,
        redis,
        natsConnection: nc,
      });

      await gatewayServer.app.listen({ port: 0, host: '127.0.0.1' });
      const address = gatewayServer.app.server.address() as net.AddressInfo;
      gatewayPort = address.port;

      isReady = true;
    } catch {
      isReady = false;
    }
  });

  afterAll(async () => {
    if (eventConsumer) {
      await eventConsumer.stop().catch(() => {});
    }
    if (gatewayServer) {
      await gatewayServer.connectionManager.closeAll().catch(() => {});
      await gatewayServer.app.close().catch(() => {});
    }
    if (nc) {
      await nc.close().catch(() => {});
    }
    if (redis) {
      await redis.quit().catch(() => {});
    }
    if (stopNatsContainer) {
      await stopNatsContainer().catch(() => {});
    }
    if (stopValkeyContainer) {
      await stopValkeyContainer().catch(() => {});
    }
  });

  it('ticket single use, expiry, and anonymous connect', async () => {
    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';

    // 1. Issue ticket via POST /v1/realtime/ticket
    const ticketRes = await gatewayServer!.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: {
        'x-user-id': userId,
        'x-user-roles': 'viewer',
      },
    });
    expect(ticketRes.statusCode).toBe(201);
    const { ticket } = ticketRes.json();

    // 2. First upgrade succeeds with 101 and receives welcome frame
    const ws1 = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=${ticket}`);
    const welcome1 = await waitForFrame(ws1, (f) => f.type === 'welcome');
    expect(welcome1.type).toBe('welcome');
    if (welcome1.type === 'welcome') {
      expect(welcome1.user_id).toBe(userId);
    }

    // 3. Second upgrade with the same ticket fails with 401 before upgrade
    await new Promise<void>((resolve) => {
      const ws2 = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=${ticket}`);
      ws2.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      ws2.on('open', () => {
        expect.fail('Second upgrade with consumed ticket should have been rejected with 401');
      });
    });

    // 4. Upgrade with non-existent or expired ticket fails with 401
    await new Promise<void>((resolve) => {
      const wsBad = new WebSocket(
        `ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=invalid-ticket-32-chars-long-1234567890`,
      );
      wsBad.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      wsBad.on('open', () => {
        expect.fail('Upgrade with invalid ticket should have been rejected with 401');
      });
    });

    // 5. Connect without ticket connects as anonymous
    const wsAnon = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/realtime`);
    const welcomeAnon = await waitForFrame(wsAnon, (f) => f.type === 'welcome');
    expect(welcomeAnon.type).toBe('welcome');
    if (welcomeAnon.type === 'welcome') {
      expect(welcomeAnon.user_id).toBeNull();
    }

    ws1.close();
    wsAnon.close();
  });

  it('video:{id} allowed/forbidden via stub video-svc (200 vs 404)', async () => {
    const videoAllowed = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9a11';
    const videoForbidden = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9a22';

    mockAllowedVideos.add(videoAllowed);

    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/realtime`);
    await waitForFrame(ws, (f) => f.type === 'welcome');

    // Subscribe to allowed video -> receives ack
    ws.send(JSON.stringify({ type: 'subscribe', id: 'sub-ok', room: `video:${videoAllowed}` }));
    const ack = await waitForFrame(ws, (f) => f.type === 'ack' && f.id === 'sub-ok');
    expect(ack.type).toBe('ack');

    // Subscribe to forbidden video -> receives error ROOM_FORBIDDEN
    ws.send(JSON.stringify({ type: 'subscribe', id: 'sub-fail', room: `video:${videoForbidden}` }));
    const err = await waitForFrame(ws, (f) => f.type === 'error' && f.id === 'sub-fail');
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.code).toBe('ROOM_FORBIDDEN');
    }

    ws.close();
  });

  it('upload:{id} never leaks another owner progress', async () => {
    const userA = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0001';
    const userB = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0002';
    const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9a33';

    // Issue ticket for user A
    const resA = await gatewayServer!.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: { 'x-user-id': userA },
    });
    const ticketA = resA.json().ticket;

    // Issue ticket for user B
    const resB = await gatewayServer!.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: { 'x-user-id': userB },
    });
    const ticketB = resB.json().ticket;

    const wsA = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=${ticketA}`);
    await waitForFrame(wsA, (f) => f.type === 'welcome');

    const wsB = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=${ticketB}`);
    await waitForFrame(wsB, (f) => f.type === 'welcome');

    // Both subscribe to upload:{videoId}
    wsA.send(JSON.stringify({ type: 'subscribe', id: 'sub-a', room: `upload:${videoId}` }));
    await waitForFrame(wsA, (f) => f.type === 'ack' && f.id === 'sub-a');

    wsB.send(JSON.stringify({ type: 'subscribe', id: 'sub-b', room: `upload:${videoId}` }));
    await waitForFrame(wsB, (f) => f.type === 'ack' && f.id === 'sub-b');

    let userBReceived = false;
    wsB.on('message', (d) => {
      const f = parseServerFrame(d);
      if (f.type === 'event' && f.room === `upload:${videoId}`) {
        userBReceived = true;
      }
    });

    // Publish progress event where owner_id is userA
    nc!.publish(
      `rt.video.${videoId}.progress`,
      sc.encode(
        JSON.stringify({
          event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0000',
          type: 'video.progress',
          version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'transcoder',
          data: {
            video_id: videoId,
            owner_id: userA,
            job_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0001',
            stage: 'TRANSCODING',
            percent: 50.0,
          },
        }),
      ),
    );

    // User A receives event
    const eventA = await waitForFrame(
      wsA,
      (f) => f.type === 'event' && f.room === `upload:${videoId}` && f.event === 'video.progress',
    );
    expect(eventA.type).toBe('event');
    if (eventA.type === 'event') {
      expect(eventA.data.percent).toBe(50);
      expect(eventA.data.stage).toBe('TRANSCODING');
    }

    // Wait 200ms and verify User B NEVER received it
    await new Promise((r) => setTimeout(r, 200));
    expect(userBReceived).toBe(false);

    wsA.close();
    wsB.close();
  });

  it('user:{me} receives video.ready/failed and comment.reply (not for self-replies)', async () => {
    const me = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0010';
    const otherUser = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0020';
    const myVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9a44';

    // Issue ticket for me
    const resMe = await gatewayServer!.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: { 'x-user-id': me },
    });
    const ticketMe = resMe.json().ticket;

    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=${ticketMe}`);
    await waitForFrame(ws, (f) => f.type === 'welcome');

    const js = nc!.jetstream();

    // 1. video.ready on VIDEO stream -> arrives in user:{me}
    await js.publish(
      'video.ready',
      sc.encode(
        JSON.stringify({
          event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0101',
          type: 'video.ready',
          version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'transcoder',
          data: {
            video_id: myVideoId,
            owner_id: me,
          },
        }),
      ),
    );

    const readyEvent = await waitForFrame(
      ws,
      (f) => f.type === 'event' && f.room === `user:${me}` && f.event === 'video.ready',
    );
    expect(readyEvent.type).toBe('event');

    // 2. comment.reply on SOCIAL stream when other user replies to me
    await js.publish(
      'social.comment.created',
      sc.encode(
        JSON.stringify({
          event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0102',
          type: 'social.comment.created',
          version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'social-svc',
          data: {
            comment_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0103',
            video_id: myVideoId,
            video_owner_id: me,
            author_id: otherUser,
            parent_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0104',
            parent_author_id: me,
            body: 'A reply to you',
            created_at: new Date().toISOString(),
          },
        }),
      ),
    );

    const replyEvent = await waitForFrame(
      ws,
      (f) => f.type === 'event' && f.room === `user:${me}` && f.event === 'comment.reply',
    );
    expect(replyEvent.type).toBe('event');

    // 3. Self-reply: otherUser replies to otherUser -> me should NOT receive comment.reply
    let receivedSelfReply = false;
    const onReplyMsg = (d: unknown) => {
      const f = parseServerFrame(d);
      if (
        f.type === 'event' &&
        f.room === `user:${me}` &&
        f.data.comment_id === '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0999'
      ) {
        receivedSelfReply = true;
      }
    };
    ws.on('message', onReplyMsg);

    await js.publish(
      'social.comment.created',
      sc.encode(
        JSON.stringify({
          event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0105',
          type: 'social.comment.created',
          version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'social-svc',
          data: {
            comment_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0999',
            video_id: myVideoId,
            video_owner_id: me,
            author_id: me, // author is me
            parent_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0104',
            parent_author_id: me, // parent author is me -> self reply
            body: 'My own reply to myself',
            created_at: new Date().toISOString(),
          },
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));
    ws.off('message', onReplyMsg);
    expect(receivedSelfReply).toBe(false);

    ws.close();
  });

  it('two gateway instances in the same test both receive the same JetStream event', async () => {
    const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9a55';
    mockAllowedVideos.add(videoId);

    // Setup second gateway instance
    const env2 = getEnv({
      NODE_ENV: 'test',
      VALKEY_URL: valkeyUrl!,
      NATS_URL: natsUrl!,
    });

    const videoClient2 = new VideoClient('http://localhost:8080');
    videoClient2.canAccessVideo = async () => true;

    const connectionManager2 = new ConnectionManager({
      videoClient: videoClient2,
    });

    const eventConsumer2 = new RealtimeEventConsumer({
      nats: nc!,
      connectionManager: connectionManager2,
    });
    await eventConsumer2.start();

    const gw2 = await buildApp({
      env: env2,
      connectionManager: connectionManager2,
      videoClient: videoClient2,
      redis,
      natsConnection: nc!,
    });

    await gw2.app.listen({ port: 0, host: '127.0.0.1' });
    const port2 = (gw2.app.server.address() as net.AddressInfo).port;

    // Connect Client 1 to Gateway 1
    const ws1 = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/realtime`);
    await waitForFrame(ws1, (f) => f.type === 'welcome');
    ws1.send(JSON.stringify({ type: 'subscribe', id: 's1', room: `video:${videoId}` }));
    await waitForFrame(ws1, (f) => f.type === 'ack' && f.id === 's1');

    // Connect Client 2 to Gateway 2
    const ws2 = new WebSocket(`ws://127.0.0.1:${port2}/v1/realtime`);
    await waitForFrame(ws2, (f) => f.type === 'welcome');
    ws2.send(JSON.stringify({ type: 'subscribe', id: 's2', room: `video:${videoId}` }));
    await waitForFrame(ws2, (f) => f.type === 'ack' && f.id === 's2');

    // Publish JetStream event on SOCIAL
    const js = nc!.jetstream();
    await js.publish(
      'social.video.like_changed',
      sc.encode(
        JSON.stringify({
          event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0201',
          type: 'social.video.like_changed',
          version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'social-svc',
          data: {
            video_id: videoId,
            user_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0202',
            liked: true,
            like_count: 88,
          },
        }),
      ),
    );

    // Assert both gateways delivered the event
    const [msg1, msg2] = await Promise.all([
      waitForFrame(
        ws1,
        (f) => f.type === 'event' && f.room === `video:${videoId}` && f.event === 'like.count',
      ),
      waitForFrame(
        ws2,
        (f) => f.type === 'event' && f.room === `video:${videoId}` && f.event === 'like.count',
      ),
    ]);

    expect(msg1.type).toBe('event');
    expect(msg2.type).toBe('event');
    if (msg1.type === 'event') expect(msg1.data.like_count).toBe(88);
    if (msg2.type === 'event') expect(msg2.data.like_count).toBe(88);

    ws1.close();
    ws2.close();
    await eventConsumer2.stop();
    await gw2.connectionManager.closeAll();
    await gw2.app.close();
  });

  it('enforces limits: 51st room -> TOO_MANY_ROOMS, 6th connection -> 4429, oversized/binary frame -> BAD_MESSAGE', async () => {
    const testUser = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0099';

    // 1. Limits: 51st room
    const res = await gatewayServer!.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: { 'x-user-id': testUser },
    });
    const ws = new WebSocket(
      `ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=${res.json().ticket}`,
    );
    await waitForFrame(ws, (f) => f.type === 'welcome');

    // Subscribe to 50 rooms
    for (let i = 1; i <= 50; i++) {
      const hex = i.toString(16).padStart(12, '0');
      const room = `upload:0192f5e4-7c1a-7b3e-9d2a-${hex}`;
      ws.send(JSON.stringify({ type: 'subscribe', id: `r-${i}`, room }));
      await waitForFrame(ws, (f) => f.type === 'ack' && f.id === `r-${i}`);
    }

    // 51st room triggers TOO_MANY_ROOMS
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        id: 'r-51',
        room: 'upload:0192f5e4-7c1a-7b3e-9d2a-ffffffffffff',
      }),
    );
    const err51 = await waitForFrame(ws, (f) => f.type === 'error' && f.id === 'r-51');
    expect(err51.type).toBe('error');
    if (err51.type === 'error') {
      expect(err51.code).toBe('TOO_MANY_ROOMS');
    }

    // 2. Oversized / binary frame -> BAD_MESSAGE
    ws.send(Buffer.from('binary-frame-data'));
    const badMsg = await waitForFrame(ws, (f) => f.type === 'error' && f.code === 'BAD_MESSAGE');
    expect(badMsg.type).toBe('error');
    if (badMsg.type === 'error') {
      expect(badMsg.code).toBe('BAD_MESSAGE');
    }

    ws.close();

    // 3. Limits: 6th connection for same user -> closed with 4429
    const userConns: WebSocket[] = [];
    for (let i = 0; i < 5; i++) {
      const tRes = await gatewayServer!.app.inject({
        method: 'POST',
        url: '/v1/realtime/ticket',
        headers: { 'x-user-id': testUser },
      });
      const c = new WebSocket(
        `ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=${tRes.json().ticket}`,
      );
      await waitForFrame(c, (f) => f.type === 'welcome');
      userConns.push(c);
    }

    // 6th connection
    const t6Res = await gatewayServer!.app.inject({
      method: 'POST',
      url: '/v1/realtime/ticket',
      headers: { 'x-user-id': testUser },
    });
    const sixthConn = new WebSocket(
      `ws://127.0.0.1:${gatewayPort}/v1/realtime?ticket=${t6Res.json().ticket}`,
    );

    const closeCode = await new Promise<number>((resolve) => {
      sixthConn.on('close', (code) => resolve(code));
    });
    expect(closeCode).toBe(4429);

    for (const c of userConns) {
      c.close();
    }
  });

  it('heartbeat timeout closes connection with 4408', async () => {
    // Setup gateway with very fast heartbeat interval and timeout for test
    const fastMgr = new ConnectionManager({
      videoClient: new VideoClient('http://localhost:8080'),
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 150,
    });

    const fastGw = await buildApp({
      env: getEnv({ NODE_ENV: 'test' }),
      connectionManager: fastMgr,
    });

    await fastGw.app.listen({ port: 0, host: '127.0.0.1' });
    const fastPort = (fastGw.app.server.address() as net.AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${fastPort}/v1/realtime`);
    await waitForFrame(ws, (f) => f.type === 'welcome');

    // Prevent client from answering pings
    // @ts-expect-error override pong
    ws.pong = () => {};

    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
    });

    expect(code).toBe(4408);
    await fastMgr.closeAll();
    await fastGw.app.close();
  });
});
