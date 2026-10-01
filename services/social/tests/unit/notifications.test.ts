import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import {
  NotificationsJanitor,
  NOTIFICATIONS_JANITOR_LOCK_KEY,
} from '../../src/janitor/notifications-janitor.js';
import { notificationsCreatedCounter } from '../../src/metrics.js';

describe('In-App Notifications Unit Tests (Task N1 / ADR-023)', () => {
  let app: FastifyInstance;
  let store: MockStore;

  const userA = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
  const userB = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002';
  const userC = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9003';
  const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010';

  beforeEach(async () => {
    store = createMockStore();
    const { db } = createMockDb(store);
    const rateLimiter = new ValkeyRateLimiter();
    const env = getEnv({
      NODE_ENV: 'test',
      MEDIA_BASE_URL: 'https://media.winkey.vn',
    });

    // Populate profiles
    store.public_profiles.push(
      { id: userA, handle: 'alice', display_name: 'Alice', avatar_key: 'avatars/alice.jpg' },
      { id: userB, handle: 'bob', display_name: 'Bob', avatar_key: null },
      { id: userC, handle: 'carol', display_name: 'Carol', avatar_key: null },
    );

    // Populate channel owned by userA
    store.channels.push({
      id: userA,
      subscriber_count: 0,
    });

    // Populate video owned by userA
    store.videos.push({
      id: videoId,
      owner_id: userA,
      like_count: 0,
      comment_count: 0,
      hidden: false,
      visibility: 'PUBLIC',
      created_at: new Date(),
    });

    app = await buildApp({
      env,
      db,
      rateLimiter,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /v1/notifications', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns empty list when user has no notifications', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const body = res.json();
      expect(body.items).toEqual([]);
      expect(body.next_cursor).toBeNull();
    });

    it('returns notifications with formatted actor profile and ISO dates', async () => {
      const notifId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9050';
      const now = new Date();
      store.notifications.push({
        id: notifId,
        user_id: userA,
        actor_id: userB,
        kind: 'NEW_SUBSCRIBER',
        video_id: null,
        comment_id: null,
        read_at: null,
        created_at: now,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0]).toEqual({
        id: notifId,
        kind: 'NEW_SUBSCRIBER',
        actor: {
          id: userB,
          handle: 'bob',
          display_name: 'Bob',
          avatar_url: null,
        },
        video_id: null,
        comment_id: null,
        created_at: now.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z'),
        read_at: null,
      });
      expect(body.next_cursor).toBeNull();
    });

    it('supports keyset cursor pagination over 45 items with limit 20 (20/20/5)', async () => {
      const baseTime = 1700000000000;
      for (let i = 0; i < 45; i++) {
        const idSuffix = String(i + 1).padStart(3, '0');
        store.notifications.push({
          id: `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9${idSuffix}`,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: new Date(baseTime + i * 1000),
        });
      }

      // Page 1
      const res1 = await app.inject({
        method: 'GET',
        url: '/v1/notifications?limit=20',
        headers: { 'x-user-id': userA },
      });
      expect(res1.statusCode).toBe(200);
      const page1 = res1.json();
      expect(page1.items.length).toBe(20);
      expect(page1.next_cursor).not.toBeNull();

      // Page 2
      const res2 = await app.inject({
        method: 'GET',
        url: `/v1/notifications?limit=20&cursor=${encodeURIComponent(page1.next_cursor)}`,
        headers: { 'x-user-id': userA },
      });
      expect(res2.statusCode).toBe(200);
      const page2 = res2.json();
      expect(page2.items.length).toBe(20);
      expect(page2.next_cursor).not.toBeNull();

      // Page 3
      const res3 = await app.inject({
        method: 'GET',
        url: `/v1/notifications?limit=20&cursor=${encodeURIComponent(page2.next_cursor)}`,
        headers: { 'x-user-id': userA },
      });
      expect(res3.statusCode).toBe(200);
      const page3 = res3.json();
      expect(page3.items.length).toBe(5);
      expect(page3.next_cursor).toBeNull();

      // Ensure no duplicate IDs across pages
      const allIds = [
        ...page1.items.map((i: any) => i.id),
        ...page2.items.map((i: any) => i.id),
        ...page3.items.map((i: any) => i.id),
      ];
      expect(new Set(allIds).size).toBe(45);
    });

    it('filters by unread=true', async () => {
      const notif1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9071';
      const notif2 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9072';
      store.notifications.push(
        {
          id: notif1,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: new Date(),
          created_at: new Date(Date.now() - 2000),
        },
        {
          id: notif2,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: new Date(),
        },
      );

      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications?unread=true',
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0].id).toBe(notif2);
    });

    it('rejects invalid limit and invalid cursor with 400', async () => {
      const resLimit = await app.inject({
        method: 'GET',
        url: '/v1/notifications?limit=0',
        headers: { 'x-user-id': userA },
      });
      expect(resLimit.statusCode).toBe(400);

      const resLimitMax = await app.inject({
        method: 'GET',
        url: '/v1/notifications?limit=101',
        headers: { 'x-user-id': userA },
      });
      expect(resLimitMax.statusCode).toBe(400);

      const resCursor = await app.inject({
        method: 'GET',
        url: '/v1/notifications?cursor=invalid-base64',
        headers: { 'x-user-id': userA },
      });
      expect(resCursor.statusCode).toBe(400);
    });

    it('omits notifications for hidden or private videos, non-visible comments, or missing actor profiles', async () => {
      const privateVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9021';
      const hiddenVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9022';
      const normalVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9023';

      store.videos.push(
        {
          id: privateVideoId,
          owner_id: userA,
          like_count: 0,
          comment_count: 0,
          hidden: false,
          visibility: 'PRIVATE',
          created_at: new Date(),
        },
        {
          id: hiddenVideoId,
          owner_id: userA,
          like_count: 0,
          comment_count: 0,
          hidden: true,
          visibility: 'PUBLIC',
          created_at: new Date(),
        },
        {
          id: normalVideoId,
          owner_id: userA,
          like_count: 0,
          comment_count: 0,
          hidden: false,
          visibility: 'PUBLIC',
          created_at: new Date(),
        },
      );

      const visibleCommentId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9031';
      const hiddenCommentId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9032';

      store.comments.push(
        {
          id: visibleCommentId,
          video_id: normalVideoId,
          author_id: userB,
          parent_id: null,
          body: 'Hello',
          status: 'VISIBLE',
          reply_count: 0,
          created_at: new Date(),
          edited_at: null,
          updated_at: new Date(),
        },
        {
          id: hiddenCommentId,
          video_id: normalVideoId,
          author_id: userB,
          parent_id: null,
          body: 'Spam',
          status: 'HIDDEN',
          reply_count: 0,
          created_at: new Date(),
          edited_at: null,
          updated_at: new Date(),
        },
      );

      const unknownActor = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099';

      store.notifications.push(
        // Inaccessible: private video
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9081',
          user_id: userA,
          actor_id: userB,
          kind: 'VIDEO_PUBLISHED',
          video_id: privateVideoId,
          comment_id: null,
          read_at: null,
          created_at: new Date(1700000001000),
        },
        // Inaccessible: hidden video
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9082',
          user_id: userA,
          actor_id: userB,
          kind: 'VIDEO_PUBLISHED',
          video_id: hiddenVideoId,
          comment_id: null,
          read_at: null,
          created_at: new Date(1700000002000),
        },
        // Inaccessible: hidden comment
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9083',
          user_id: userA,
          actor_id: userB,
          kind: 'VIDEO_COMMENT',
          video_id: normalVideoId,
          comment_id: hiddenCommentId,
          read_at: null,
          created_at: new Date(1700000003000),
        },
        // Inaccessible: missing actor profile
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9084',
          user_id: userA,
          actor_id: unknownActor,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: new Date(1700000004000),
        },
        // Accessible: normal video comment
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9085',
          user_id: userA,
          actor_id: userB,
          kind: 'VIDEO_COMMENT',
          video_id: normalVideoId,
          comment_id: visibleCommentId,
          read_at: null,
          created_at: new Date(1700000005000),
        },
      );

      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0].id).toBe('0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9085');
    });

    it('obeys common.yaml limit parameter: default 24, max 100, rejects <1 or >100', async () => {
      for (let i = 0; i < 105; i++) {
        const idSuffix = String(i + 1).padStart(3, '0');
        store.notifications.push({
          id: `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be${idSuffix}`,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: new Date(Date.now() - i * 1000),
        });
      }

      // Default: returns 24
      const defaultRes = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { 'x-user-id': userA },
      });
      expect(defaultRes.statusCode).toBe(200);
      expect(defaultRes.json().items).toHaveLength(24);

      // Explicit limit=100
      const limit100Res = await app.inject({
        method: 'GET',
        url: '/v1/notifications?limit=100',
        headers: { 'x-user-id': userA },
      });
      expect(limit100Res.statusCode).toBe(200);
      expect(limit100Res.json().items).toHaveLength(100);

      // Invalid: limit=101
      const limit101Res = await app.inject({
        method: 'GET',
        url: '/v1/notifications?limit=101',
        headers: { 'x-user-id': userA },
      });
      expect(limit101Res.statusCode).toBe(400);

      // Invalid: limit=0
      const limit0Res = await app.inject({
        method: 'GET',
        url: '/v1/notifications?limit=0',
        headers: { 'x-user-id': userA },
      });
      expect(limit0Res.statusCode).toBe(400);
    });
  });

  describe('GET /v1/notifications/unread-count', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications/unread-count',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns count 0 and capped false when no unread notifications', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications/unread-count',
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ count: 0, capped: false });
    });

    it('counts accurately and caps at 100 with capped true at 101', async () => {
      for (let i = 0; i < 101; i++) {
        const idSuffix = String(i + 1).padStart(3, '0');
        store.notifications.push({
          id: `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8ba${idSuffix}`,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: new Date(),
        });
      }

      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications/unread-count',
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ count: 100, capped: true });
    });
  });

  describe('POST /v1/notifications/read', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        payload: { ids: ['0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001'] },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when both ids and up_to are provided or neither is provided', async () => {
      const resBoth = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: {
          ids: ['0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001'],
          up_to: new Date().toISOString(),
        },
      });
      expect(resBoth.statusCode).toBe(400);

      const resNeither = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: {},
      });
      expect(resNeither.statusCode).toBe(400);

      const resExtra = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: {
          ids: ['0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001'],
          foo: 'bar',
        },
      });
      expect(resExtra.statusCode).toBe(400);
    });

    it('returns 400 when ids array is invalid (empty, >100, invalid UUID, duplicates)', async () => {
      const resEmpty = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: { ids: [] },
      });
      expect(resEmpty.statusCode).toBe(400);

      const resInvalidUuid = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: { ids: ['invalid-uuid'] },
      });
      expect(resInvalidUuid.statusCode).toBe(400);

      const resDup = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: {
          ids: ['0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001', '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001'],
        },
      });
      expect(resDup.statusCode).toBe(400);
    });

    it('marks notifications by ids and ignores foreign ids idempotently', async () => {
      const notif1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9091';
      const foreignNotif = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9092';
      store.notifications.push(
        {
          id: notif1,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: new Date(),
        },
        {
          id: foreignNotif,
          user_id: userB,
          actor_id: userA,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: new Date(),
        },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: { ids: [notif1, foreignNotif] },
      });
      expect(res.statusCode).toBe(204);

      const n1 = store.notifications.find((n) => n.id === notif1);
      expect(n1?.read_at).not.toBeNull();

      const nForeign = store.notifications.find((n) => n.id === foreignNotif);
      expect(nForeign?.read_at).toBeNull(); // foreign notification untouched
    });

    it('marks notifications by up_to date', async () => {
      const oldNotif = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9093';
      const newNotif = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9094';
      const t1 = new Date('2026-01-01T10:00:00Z');
      const t2 = new Date('2026-01-02T10:00:00Z');

      store.notifications.push(
        {
          id: oldNotif,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: t1,
        },
        {
          id: newNotif,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: t2,
        },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: { up_to: '2026-01-01T12:00:00Z' },
      });
      expect(res.statusCode).toBe(204);

      expect(store.notifications.find((n) => n.id === oldNotif)?.read_at).not.toBeNull();
      expect(store.notifications.find((n) => n.id === newNotif)?.read_at).toBeNull();
    });

    it('marks row at .123456Z as read with up_to .123Z due to 1ms interval extension', async () => {
      const microsNotif = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9095';
      const laterNotif = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9096';
      const tMicros = new Date('2026-09-30T10:00:00.123Z');
      const tLater = new Date('2026-09-30T10:00:00.125Z');

      store.notifications.push(
        {
          id: microsNotif,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: tMicros,
          created_at_micros: '2026-09-30T10:00:00.123456Z',
        },
        {
          id: laterNotif,
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: tLater,
          created_at_micros: '2026-09-30T10:00:00.125000Z',
        },
      );

      // Verify GET /v1/notifications returns microsecond precision
      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { 'x-user-id': userA },
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json();
      const returnedItem = getBody.items.find((i: any) => i.id === microsNotif);
      expect(returnedItem).toBeDefined();
      expect(returnedItem.created_at).toBe('2026-09-30T10:00:00.123456Z');

      // POST /v1/notifications/read with up_to at millisecond precision .123Z
      const res = await app.inject({
        method: 'POST',
        url: '/v1/notifications/read',
        headers: { 'x-user-id': userA },
        payload: { up_to: '2026-09-30T10:00:00.123Z' },
      });
      expect(res.statusCode).toBe(204);

      // Row at .123456Z is marked read because .123456Z < .123Z + 1ms (.124Z)
      expect(store.notifications.find((n) => n.id === microsNotif)?.read_at).not.toBeNull();
      // Row at .125Z is NOT marked read
      expect(store.notifications.find((n) => n.id === laterNotif)?.read_at).toBeNull();
    });

    it('rejects invalid up_to formats with 400 (RFC 3339 regex)', async () => {
      const invalidFormats = [
        'invalid-date',
        '2026-09-30',
        '2026-09-30 10:00:00',
        '2026-09-30T10:00:00', // missing timezone / Z
        123456,
      ];

      for (const invalid of invalidFormats) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/notifications/read',
          headers: { 'x-user-id': userA },
          payload: { up_to: invalid },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('INVALID_DATE');
      }
    });
  });

  describe('Notifications Janitor', () => {
    it('only one of two concurrent runs acquires the advisory lock', async () => {
      const mockPool = {
        connect: vi.fn().mockImplementation(async () => {
          return {
            query: vi.fn().mockImplementation(async (sql: string) => {
              if (sql.includes('pg_try_advisory_lock')) {
                if (store.advisory_locks.has(NOTIFICATIONS_JANITOR_LOCK_KEY)) {
                  return { rows: [{ locked: false }] };
                }
                store.advisory_locks.add(NOTIFICATIONS_JANITOR_LOCK_KEY);
                return { rows: [{ locked: true }] };
              }
              if (sql.includes('pg_advisory_unlock')) {
                store.advisory_locks.delete(NOTIFICATIONS_JANITOR_LOCK_KEY);
                return { rows: [{ unlocked: true }] };
              }
              if (sql.includes('DELETE FROM social.notifications')) {
                return { rowCount: 0 };
              }
              return { rows: [] };
            }),
            release: vi.fn(),
          };
        }),
      } as any;

      const janitor1 = new NotificationsJanitor({ pool: mockPool });
      const janitor2 = new NotificationsJanitor({ pool: mockPool });

      // Run janitor 1 (acquires lock)
      store.advisory_locks.add(NOTIFICATIONS_JANITOR_LOCK_KEY);
      const res2 = await janitor2.runOnce();
      expect(res2).toBe(0); // skipped because locked

      store.advisory_locks.delete(NOTIFICATIONS_JANITOR_LOCK_KEY);
      const res1 = await janitor1.runOnce();
      expect(res1).toBe(0);
      expect(store.advisory_locks.has(NOTIFICATIONS_JANITOR_LOCK_KEY)).toBe(false);
    });

    it('deletes only rows older than retention days in batches', async () => {
      const now = Date.now();
      const oldTime = new Date(now - 95 * 24 * 60 * 60 * 1000); // 95 days old
      const recentTime = new Date(now - 10 * 24 * 60 * 60 * 1000); // 10 days old

      store.notifications.push(
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9098',
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: oldTime,
        },
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
          user_id: userA,
          actor_id: userB,
          kind: 'NEW_SUBSCRIBER',
          video_id: null,
          comment_id: null,
          read_at: null,
          created_at: recentTime,
        },
      );

      const mockClient = {
        async query(sqlText: string) {
          if (sqlText.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          if (sqlText.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
          if (sqlText.includes('DELETE FROM social.notifications')) {
            const initial = store.notifications.length;
            const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
            store.notifications = store.notifications.filter((n) => n.created_at >= cutoff);
            return { rowCount: initial - store.notifications.length };
          }
          return { rows: [] };
        },
        release: () => {},
      };
      const mockPool = {
        connect: async () => mockClient,
      } as any;

      const janitor = new NotificationsJanitor({ pool: mockPool, retentionDays: 90 });
      const deleted = await janitor.runOnce();
      expect(deleted).toBe(1);
      expect(store.notifications.length).toBe(1);
      expect(store.notifications[0].id).toBe('0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099');
    });
  });

  describe('Writers: Comments and Subscriptions notifications', () => {
    it('creates VIDEO_COMMENT notification on top-level comment and omits for self-comment', async () => {
      // User B comments on User A's video -> User A notified
      const res1 = await app.inject({
        method: 'POST',
        url: `/v1/videos/${videoId}/comments`,
        headers: { 'x-user-id': userB },
        payload: { body: 'Great video!' },
      });
      expect(res1.statusCode).toBe(201);
      const comment1 = res1.json();

      const notif1 = store.notifications.find(
        (n) => n.user_id === userA && n.kind === 'VIDEO_COMMENT',
      );
      expect(notif1).toBeDefined();
      expect(notif1?.actor_id).toBe(userB);
      expect(notif1?.video_id).toBe(videoId);
      expect(notif1?.comment_id).toBe(comment1.id);

      // User A comments on their own video -> no notification
      const initialCount = store.notifications.length;
      const res2 = await app.inject({
        method: 'POST',
        url: `/v1/videos/${videoId}/comments`,
        headers: { 'x-user-id': userA },
        payload: { body: 'Thanks everyone!' },
      });
      expect(res2.statusCode).toBe(201);
      expect(store.notifications.length).toBe(initialCount);
    });

    it('creates COMMENT_REPLY notification for parent author and does NOT notify video owner', async () => {
      // Setup top-level comment by User B
      const parentRes = await app.inject({
        method: 'POST',
        url: `/v1/videos/${videoId}/comments`,
        headers: { 'x-user-id': userB },
        payload: { body: 'Original question' },
      });
      const parentComment = parentRes.json();
      store.notifications.length = 0; // clear

      // User C replies to User B's comment
      const replyRes = await app.inject({
        method: 'POST',
        url: `/v1/videos/${videoId}/comments`,
        headers: { 'x-user-id': userC },
        payload: { parent_id: parentComment.id, body: 'Here is the answer' },
      });
      expect(replyRes.statusCode).toBe(201);
      const replyComment = replyRes.json();

      // Only User B (parent author) is notified with COMMENT_REPLY
      expect(store.notifications.length).toBe(1);
      const replyNotif = store.notifications[0];
      expect(replyNotif.user_id).toBe(userB);
      expect(replyNotif.actor_id).toBe(userC);
      expect(replyNotif.kind).toBe('COMMENT_REPLY');
      expect(replyNotif.comment_id).toBe(replyComment.id);
      expect(replyNotif.video_id).toBe(videoId);

      // Video owner (userA) is NOT notified on reply
      const videoOwnerNotif = store.notifications.find((n) => n.user_id === userA);
      expect(videoOwnerNotif).toBeUndefined();
    });

    it('creates NEW_SUBSCRIBER on first subscribe and deduplicates repeat subscriptions', async () => {
      const initialMetrics =
        (await notificationsCreatedCounter.get()).values.find(
          (v) => v.labels.kind === 'NEW_SUBSCRIBER',
        )?.value ?? 0;

      // User B subscribes to User A
      const res1 = await app.inject({
        method: 'PUT',
        url: `/v1/channels/${userA}/subscription`,
        headers: { 'x-user-id': userB },
      });
      expect(res1.statusCode).toBe(200);

      const notif = store.notifications.find(
        (n) => n.user_id === userA && n.kind === 'NEW_SUBSCRIBER',
      );
      expect(notif).toBeDefined();
      expect(notif?.actor_id).toBe(userB);

      const afterRes1Metrics =
        (await notificationsCreatedCounter.get()).values.find(
          (v) => v.labels.kind === 'NEW_SUBSCRIBER',
        )?.value ?? 0;
      expect(afterRes1Metrics).toBe(initialMetrics + 1);

      // Subscribe again -> idempotent, no new notification and counter NOT incremented
      const initialCount = store.notifications.length;
      const res2 = await app.inject({
        method: 'PUT',
        url: `/v1/channels/${userA}/subscription`,
        headers: { 'x-user-id': userB },
      });
      expect(res2.statusCode).toBe(200);
      expect(store.notifications.length).toBe(initialCount);

      const afterRes2Metrics =
        (await notificationsCreatedCounter.get()).values.find(
          (v) => v.labels.kind === 'NEW_SUBSCRIBER',
        )?.value ?? 0;
      expect(afterRes2Metrics).toBe(initialMetrics + 1);
    });
  });
});
