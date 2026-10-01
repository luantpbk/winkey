import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RealtimeEventConsumer } from '../../src/nats/consumer.js';
import type { ConnectionManager } from '../../src/websocket/connection-manager.js';
import { validateServerMessage } from '../../src/schemas/validation.js';
import { realtimeRegistry } from '../../src/metrics.js';
import type { JsMsg } from 'nats';

describe('Task N2: Realtime Notification Hints Consumer Mapping', () => {
  let broadcastCalls: Array<{
    room: string;
    event: string;
    data: Record<string, unknown>;
    ownerId?: string;
  }>;
  let mockConnectionManager: ConnectionManager;
  let warnLogs: Array<{ obj: unknown; msg?: string }>;
  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: (obj: unknown, msg?: string) => void;
    error: ReturnType<typeof vi.fn>;
  };
  let consumer: RealtimeEventConsumer;

  const alice = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
  const bob = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002';
  const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010';
  const commentId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9020';
  const parentCommentId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9030';

  beforeEach(() => {
    broadcastCalls = [];
    warnLogs = [];
    mockConnectionManager = {
      broadcastEvent: vi.fn(
        (room: string, event: string, data: Record<string, unknown>, ownerId?: string) => {
          broadcastCalls.push({ room, event, data, ownerId });
        },
      ),
    } as unknown as ConnectionManager;

    mockLogger = {
      info: vi.fn(),
      warn: (obj: unknown, msg?: string) => {
        warnLogs.push({ obj, msg });
      },
      error: vi.fn(),
    };

    consumer = new RealtimeEventConsumer({
      nats: {} as unknown as import('nats').NatsConnection,
      connectionManager: mockConnectionManager,
      logger: mockLogger,
    });
  });

  function createMockJsMsg(subject: string, payload: Record<string, unknown>): JsMsg {
    return {
      subject,
      data: new TextEncoder().encode(JSON.stringify(payload)),
    } as unknown as JsMsg;
  }

  function simulateMessage(subject: string, payload: Record<string, unknown>) {
    (
      consumer as unknown as { handleJetStreamMessage: (msg: JsMsg) => void }
    ).handleJetStreamMessage(createMockJsMsg(subject, payload));
  }

  describe('social.comment.created mapping', () => {
    it('top-level comment by viewer notifies video owner with VIDEO_COMMENT hint', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.comment.created',
        version: 1,
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {
          comment_id: commentId,
          video_id: videoId,
          video_owner_id: bob,
          author_id: alice,
          parent_id: null,
          parent_author_id: null,
          body: 'Great video!',
          created_at: '2026-10-01T04:00:00.000Z',
        },
      };

      simulateMessage('social.comment.created', event);

      // Should broadcast comment.created to video room
      const commentCreated = broadcastCalls.find((c) => c.event === 'comment.created');
      expect(commentCreated).toBeDefined();
      expect(commentCreated!.room).toBe(`video:${videoId}`);

      // Should broadcast notification.hint VIDEO_COMMENT to video owner user room
      const hint = broadcastCalls.find((c) => c.event === 'notification.hint');
      expect(hint).toBeDefined();
      expect(hint!.room).toBe(`user:${bob}`);
      expect(hint!.data).toEqual({ kind: 'VIDEO_COMMENT' });

      // No comment.reply
      const reply = broadcastCalls.find((c) => c.event === 'comment.reply');
      expect(reply).toBeUndefined();

      // Validate outgoing frame against server schema
      const serverFrame = {
        type: 'event',
        room: hint!.room,
        event: hint!.event,
        data: hint!.data,
        ts: new Date().toISOString(),
      };
      const validation = validateServerMessage(serverFrame);
      expect(validation.valid, validation.error).toBe(true);
    });

    it('reply comment by viewer notifies parent author with COMMENT_REPLY hint and comment.reply', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.comment.created',
        version: 1,
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {
          comment_id: commentId,
          video_id: videoId,
          video_owner_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9009', // third party owner
          author_id: alice,
          parent_id: parentCommentId,
          parent_author_id: bob,
          body: 'Replying to you Bob',
          created_at: '2026-10-01T04:00:00.000Z',
        },
      };

      simulateMessage('social.comment.created', event);

      // Should broadcast comment.created to video room
      expect(
        broadcastCalls.some((c) => c.event === 'comment.created' && c.room === `video:${videoId}`),
      ).toBe(true);

      // Should broadcast comment.reply to parent author
      const reply = broadcastCalls.find((c) => c.event === 'comment.reply');
      expect(reply).toBeDefined();
      expect(reply!.room).toBe(`user:${bob}`);

      // Should broadcast notification.hint COMMENT_REPLY to parent author
      const hint = broadcastCalls.find((c) => c.event === 'notification.hint');
      expect(hint).toBeDefined();
      expect(hint!.room).toBe(`user:${bob}`);
      expect(hint!.data).toEqual({ kind: 'COMMENT_REPLY' });

      // No VIDEO_COMMENT hint should be sent
      expect(
        broadcastCalls.some(
          (c) => c.event === 'notification.hint' && c.data.kind === 'VIDEO_COMMENT',
        ),
      ).toBe(false);

      // Validate schema
      const serverFrame = {
        type: 'event',
        room: hint!.room,
        event: hint!.event,
        data: hint!.data,
        ts: new Date().toISOString(),
      };
      expect(validateServerMessage(serverFrame).valid).toBe(true);
    });

    it('self-comment: video owner commenting on their own video sends NO notification.hint', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.comment.created',
        version: 1,
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {
          comment_id: commentId,
          video_id: videoId,
          video_owner_id: alice,
          author_id: alice,
          parent_id: null,
          parent_author_id: null,
          body: 'Owner comment',
          created_at: '2026-10-01T04:00:00.000Z',
        },
      };

      simulateMessage('social.comment.created', event);

      // comment.created is sent to video room
      expect(broadcastCalls.some((c) => c.event === 'comment.created')).toBe(true);

      // BUT NO notification.hint is sent
      expect(broadcastCalls.some((c) => c.event === 'notification.hint')).toBe(false);
    });

    it('self-reply: author replying to their own comment sends NO notification.hint and NO comment.reply', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.comment.created',
        version: 1,
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {
          comment_id: commentId,
          video_id: videoId,
          video_owner_id: bob,
          author_id: alice,
          parent_id: parentCommentId,
          parent_author_id: alice, // self-reply
          body: 'Alice replying to herself',
          created_at: '2026-10-01T04:00:00.000Z',
        },
      };

      simulateMessage('social.comment.created', event);

      // comment.created is sent to video room
      expect(broadcastCalls.some((c) => c.event === 'comment.created')).toBe(true);

      // NO comment.reply and NO notification.hint
      expect(broadcastCalls.some((c) => c.event === 'comment.reply')).toBe(false);
      expect(broadcastCalls.some((c) => c.event === 'notification.hint')).toBe(false);
    });
  });

  describe('social.subscription.changed mapping', () => {
    it('new subscription (subscribed: true) notifies channel owner with NEW_SUBSCRIBER hint', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.subscription.changed',
        version: 1,
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {
          subscriber_id: alice,
          channel_id: bob,
          subscribed: true,
          subscriber_count: 42,
        },
      };

      simulateMessage('social.subscription.changed', event);

      expect(broadcastCalls.length).toBe(1);
      const hint = broadcastCalls[0];
      expect(hint.room).toBe(`user:${bob}`);
      expect(hint.event).toBe('notification.hint');
      expect(hint.data).toEqual({ kind: 'NEW_SUBSCRIBER' });

      // Schema check
      const serverFrame = {
        type: 'event',
        room: hint.room,
        event: hint.event,
        data: hint.data,
        ts: new Date().toISOString(),
      };
      expect(validateServerMessage(serverFrame).valid).toBe(true);
    });

    it('unsubscribe (subscribed: false) sends nothing', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.subscription.changed',
        version: 1,
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {
          subscriber_id: alice,
          channel_id: bob,
          subscribed: false,
          subscriber_count: 41,
        },
      };

      simulateMessage('social.subscription.changed', event);

      expect(broadcastCalls.length).toBe(0);
    });

    it('self-subscribe (subscriber_id === channel_id) sends nothing', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.subscription.changed',
        version: 1,
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {
          subscriber_id: bob,
          channel_id: bob,
          subscribed: true,
          subscriber_count: 10,
        },
      };

      simulateMessage('social.subscription.changed', event);

      expect(broadcastCalls.length).toBe(0);
    });
  });

  describe('version handling and edge cases', () => {
    it('ignores unknown event version (version !== 1) and logs warning', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.subscription.changed',
        version: 2, // unknown version
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {
          subscriber_id: alice,
          channel_id: bob,
          subscribed: true,
          subscriber_count: 42,
        },
      };

      simulateMessage('social.subscription.changed', event);

      expect(broadcastCalls.length).toBe(0);
      expect(warnLogs.some((l) => l.msg?.includes('unknown version'))).toBe(true);
    });

    it('drops missing or malformed data gracefully without error', () => {
      const event = {
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
        type: 'social.subscription.changed',
        version: 1,
        occurred_at: '2026-10-01T04:00:00.000Z',
        producer: 'social-svc',
        data: {}, // missing channel_id and subscriber_id
      };

      simulateMessage('social.subscription.changed', event);

      expect(broadcastCalls.length).toBe(0);
    });
  });

  describe('outgoing frame schema validation & metrics in ConnectionManager', () => {
    it('sends valid notification.hint frame and increments notificationHintsCounter', async () => {
      const { VideoClient } = await import('../../src/video/video-client.js');
      const { ConnectionManager } = await import('../../src/websocket/connection-manager.js');
      const videoClient = new VideoClient('http://localhost:8080');
      const manager = new ConnectionManager({ videoClient });

      const sentFrames: string[] = [];
      const mockWs = {
        readyState: 1,
        send: (data: string, cb?: () => void) => {
          sentFrames.push(data);
          cb?.();
        },
        close: () => {},
        on: () => {},
        ping: () => {},
      } as unknown as import('ws').WebSocket;

      const userTarget = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0005';
      const connId = manager.handleNewConnection(mockWs, { userId: userTarget, roles: [] });
      expect(connId).toBeTruthy();

      const initialMetric = await (
        realtimeRegistry.getSingleMetric(
          'realtime_notification_hints_total',
        ) as import('prom-client').Counter
      )?.get();
      const initialCount =
        initialMetric?.values?.find((v) => v.labels?.kind === 'VIDEO_COMMENT')?.value ?? 0;

      // Broadcast valid notification.hint
      manager.broadcastEvent(`user:${userTarget}`, 'notification.hint', { kind: 'VIDEO_COMMENT' });

      // Frame should be sent to socket
      const hintFrameStr = sentFrames.find((f) => f.includes('notification.hint'));
      expect(hintFrameStr).toBeDefined();
      const hintFrame = JSON.parse(hintFrameStr!);
      expect(hintFrame.type).toBe('event');
      expect(hintFrame.event).toBe('notification.hint');
      expect(hintFrame.data).toEqual({ kind: 'VIDEO_COMMENT' });

      // Metric should increment
      const afterMetric = await (
        realtimeRegistry.getSingleMetric(
          'realtime_notification_hints_total',
        ) as import('prom-client').Counter
      )?.get();
      const afterCount =
        afterMetric?.values?.find((v) => v.labels?.kind === 'VIDEO_COMMENT')?.value ?? 0;
      expect(afterCount).toBe(initialCount + 1);
    });

    it('drops invalid outgoing frames, increments invalidServerFramesCounter, and does not send', async () => {
      const { VideoClient } = await import('../../src/video/video-client.js');
      const { ConnectionManager } = await import('../../src/websocket/connection-manager.js');
      const { invalidServerFramesCounter } = await import('../../src/metrics.js');
      const videoClient = new VideoClient('http://localhost:8080');
      const manager = new ConnectionManager({ videoClient });

      const sentFrames: string[] = [];
      const mockWs = {
        readyState: 1,
        send: (data: string, cb?: () => void) => {
          sentFrames.push(data);
          cb?.();
        },
        close: () => {},
        on: () => {},
        ping: () => {},
      } as unknown as import('ws').WebSocket;

      const userTarget = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0006';
      const connId = manager.handleNewConnection(mockWs, { userId: userTarget, roles: [] });
      expect(connId).toBeTruthy();

      const initialMetric = await invalidServerFramesCounter.get();
      const initialCount = initialMetric?.values?.[0]?.value ?? 0;

      const conn = (manager as unknown as { connections: Map<string, unknown> }).connections.get(
        connId!,
      );
      expect(conn).toBeDefined();

      // Broadcast invalid frame: missing required data for notification.hint
      manager.broadcastEvent(`user:${userTarget}`, 'notification.hint', { invalid_field: 123 });

      // Should be dropped (not sent to mockWs)
      expect(sentFrames.some((f) => f.includes('invalid_field'))).toBe(false);

      // Metric should increment
      const afterMetric = await invalidServerFramesCounter.get();
      const afterCount = afterMetric?.values?.[0]?.value ?? 0;
      expect(afterCount).toBe(initialCount + 1);
    });
  });
});
