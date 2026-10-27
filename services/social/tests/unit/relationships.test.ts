import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { isBlockedEitherWay, shouldSuppressNotification } from '../../src/utils/blocks.js';
import type { FastifyInstance } from 'fastify';

describe('SOC-1b Relationships, Private Accounts, Blocks & Mutes Unit Tests', () => {
  let app: FastifyInstance;
  let mockStore: MockStore;
  let db: any;
  let rateLimiter: ValkeyRateLimiter;

  const userAlice = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
  const userBob = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002'; // Bob has a private account
  const userCharlie = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9003';
  const userDave = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9004';
  const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010';

  beforeAll(async () => {
    mockStore = createMockStore();
    const mock = createMockDb(mockStore);
    db = mock.db;
    rateLimiter = new ValkeyRateLimiter();

    const env = getEnv({
      NODE_ENV: 'test',
      MEDIA_BASE_URL: 'https://media.winkey.vn',
    });

    app = await buildApp({
      env,
      db,
      rateLimiter,
    });
  });

  beforeEach(() => {
    mockStore.videos = [
      {
        id: videoId,
        owner_id: userAlice,
        like_count: 0,
        comment_count: 0,
        created_at: new Date(),
        hidden: false,
        visibility: 'PUBLIC',
      },
    ];
    mockStore.comments = [];
    mockStore.video_likes = [];
    mockStore.channels = [
      { id: userAlice, subscriber_count: 0 },
      { id: userBob, subscriber_count: 0 },
      { id: userCharlie, subscriber_count: 0 },
      { id: userDave, subscriber_count: 0 },
    ];
    mockStore.subscriptions = [];
    mockStore.follow_requests = [];
    mockStore.blocks = [];
    mockStore.mutes = [];
    mockStore.outbox = [];
    mockStore.notifications = [];
    mockStore.public_profiles = [
      {
        id: userAlice,
        handle: 'alice',
        display_name: 'Alice',
        avatar_key: null,
        is_private: false,
      },
      {
        id: userBob,
        handle: 'bob_priv',
        display_name: 'Bob Private',
        avatar_key: null,
        is_private: true,
      },
      {
        id: userCharlie,
        handle: 'charlie',
        display_name: 'Charlie',
        avatar_key: null,
        is_private: false,
      },
      {
        id: userDave,
        handle: 'dave',
        display_name: 'Dave',
        avatar_key: null,
        is_private: false,
      },
    ];
  });

  describe('1. Block and Notification Suppression Helpers', () => {
    it('isBlockedEitherWay detects blocks in both directions', async () => {
      expect(await isBlockedEitherWay(db, userAlice, userBob)).toBe(false);

      mockStore.blocks.push({
        blocker_id: userAlice,
        blocked_id: userBob,
        created_at: new Date(),
      });

      expect(await isBlockedEitherWay(db, userAlice, userBob)).toBe(true);
      expect(await isBlockedEitherWay(db, userBob, userAlice)).toBe(true);
      expect(await isBlockedEitherWay(db, userAlice, userCharlie)).toBe(false);
    });

    it('shouldSuppressNotification suppresses self, block (either way), and mute', async () => {
      // Self
      expect(await shouldSuppressNotification(db, userAlice, userAlice)).toBe(true);

      // Normal
      expect(await shouldSuppressNotification(db, userAlice, userBob)).toBe(false);

      // Blocked
      mockStore.blocks.push({
        blocker_id: userBob,
        blocked_id: userAlice,
        created_at: new Date(),
      });
      expect(await shouldSuppressNotification(db, userAlice, userBob)).toBe(true);
      mockStore.blocks = [];

      // Muted: Bob muted Alice -> notifications from Alice to Bob are suppressed
      mockStore.mutes.push({
        muter_id: userBob,
        muted_id: userAlice,
        created_at: new Date(),
      });
      expect(await shouldSuppressNotification(db, userAlice, userBob)).toBe(true);
      // But notifications from Bob to Alice are not suppressed
      expect(await shouldSuppressNotification(db, userBob, userAlice)).toBe(false);
    });
  });

  describe('2. Subscriptions & Private Account Follow Requests', () => {
    it('subscribing to a public channel subscribes immediately and emits outbox event', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/channels/${userAlice}/subscription`,
        headers: { 'x-user-id': userCharlie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.subscribed).toBe(true);
      expect(body.requested).toBe(false);
      expect(body.subscriber_count).toBe(1);

      // Outbox event
      const event = mockStore.outbox.find((o) => o.subject === 'social.subscription.changed');
      expect(event).toBeDefined();
      expect((event?.payload as any).data.subscribed).toBe(true);

      // Notification
      const notif = mockStore.notifications.find((n) => n.kind === 'NEW_SUBSCRIBER');
      expect(notif).toBeDefined();
      expect(notif?.user_id).toBe(userAlice);
      expect(notif?.actor_id).toBe(userCharlie);
    });

    it('subscribing to a private account creates a follow request (requested: true, subscribed: false, no outbox event)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/channels/${userBob}/subscription`,
        headers: { 'x-user-id': userCharlie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.subscribed).toBe(false);
      expect(body.requested).toBe(true);

      // NO outbox event
      const event = mockStore.outbox.find((o) => o.subject === 'social.subscription.changed');
      expect(event).toBeUndefined();

      // In-app notification to Bob
      const notif = mockStore.notifications.find((n) => n.kind === 'FOLLOW_REQUEST');
      expect(notif).toBeDefined();
      expect(notif?.user_id).toBe(userBob);
      expect(notif?.actor_id).toBe(userCharlie);

      // Calling again is idempotent
      const res2 = await app.inject({
        method: 'PUT',
        url: `/v1/channels/${userBob}/subscription`,
        headers: { 'x-user-id': userCharlie },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().requested).toBe(true);
    });

    it('getSubscription returns requested: true when pending follow request exists', async () => {
      mockStore.follow_requests.push({
        requester_id: userCharlie,
        target_id: userBob,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userBob}/subscription`,
        headers: { 'x-user-id': userCharlie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().subscribed).toBe(false);
      expect(res.json().requested).toBe(true);
    });

    it('unsubscribe cancels pending follow request', async () => {
      mockStore.follow_requests.push({
        requester_id: userCharlie,
        target_id: userBob,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/channels/${userBob}/subscription`,
        headers: { 'x-user-id': userCharlie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().subscribed).toBe(false);
      expect(res.json().requested).toBe(false);
      expect(mockStore.follow_requests.length).toBe(0);
    });

    it('subscribing to a channel when blocked in either direction returns 404', async () => {
      mockStore.blocks.push({
        blocker_id: userAlice,
        blocked_id: userCharlie,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/channels/${userAlice}/subscription`,
        headers: { 'x-user-id': userCharlie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('subscribing when outgoing follow requests limit (200) is reached returns 409 LIMIT_REACHED', async () => {
      // Seed 200 outgoing requests for Charlie
      for (let i = 0; i < 200; i++) {
        mockStore.follow_requests.push({
          requester_id: userCharlie,
          target_id: `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b${String(i + 100).padStart(4, '0')}`,
          created_at: new Date(),
        });
      }

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/channels/${userBob}/subscription`,
        headers: { 'x-user-id': userCharlie },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('LIMIT_REACHED');
    });
  });

  describe('3. Follow Request Decisions & Listing', () => {
    beforeEach(() => {
      mockStore.follow_requests.push({
        requester_id: userCharlie,
        target_id: userBob,
        created_at: new Date(),
      });
    });

    it('listFollowRequests returns pending requests and pending_count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/follow-requests',
        headers: { 'x-user-id': userBob },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.pending_count).toBe(1);
      expect(body.items.length).toBe(1);
      expect(body.items[0].requester.id).toBe(userCharlie);
      expect(body.items[0].requested_at).toBeDefined();
    });

    it('decideFollowRequest APPROVE converts request to subscription and sends notifications', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/me/follow-requests/${userCharlie}/decision`,
        headers: { 'x-user-id': userBob },
        payload: { decision: 'APPROVE' },
      });

      expect(res.statusCode).toBe(204);
      expect(mockStore.follow_requests.length).toBe(0);

      // Subscription created
      const sub = mockStore.subscriptions.find(
        (s) => s.subscriber_id === userCharlie && s.channel_id === userBob,
      );
      expect(sub).toBeDefined();

      // Outbox event
      const event = mockStore.outbox.find((o) => o.subject === 'social.subscription.changed');
      expect(event).toBeDefined();

      // In-app notifications: NEW_SUBSCRIBER to Bob, FOLLOW_REQUEST_APPROVED to Charlie
      const newSubNotif = mockStore.notifications.find(
        (n) => n.kind === 'NEW_SUBSCRIBER' && n.user_id === userBob,
      );
      expect(newSubNotif).toBeDefined();

      const approvedNotif = mockStore.notifications.find(
        (n) => n.kind === 'FOLLOW_REQUEST_APPROVED' && n.user_id === userCharlie,
      );
      expect(approvedNotif).toBeDefined();
      expect(approvedNotif?.actor_id).toBe(userBob);
    });

    it('decideFollowRequest REJECT deletes request without notifying requester', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/me/follow-requests/${userCharlie}/decision`,
        headers: { 'x-user-id': userBob },
        payload: { decision: 'REJECT' },
      });

      expect(res.statusCode).toBe(204);
      expect(mockStore.follow_requests.length).toBe(0);

      // No new notifications
      const notifs = mockStore.notifications.filter(
        (n) => n.kind === 'FOLLOW_REQUEST_APPROVED' || n.kind === 'NEW_SUBSCRIBER',
      );
      expect(notifs.length).toBe(0);
    });

    it('decideFollowRequest on non-existent request returns 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/me/follow-requests/${userDave}/decision`,
        headers: { 'x-user-id': userBob },
        payload: { decision: 'APPROVE' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('4. Followers & Following Lists Visibility', () => {
    beforeEach(() => {
      mockStore.subscriptions.push({
        subscriber_id: userCharlie,
        channel_id: userBob,
        created_at: new Date(),
      });
    });

    it('private channel followers list is 403 for strangers and anonymous', async () => {
      // Anonymous
      const resAnon = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userBob}/followers`,
      });
      expect(resAnon.statusCode).toBe(403);
      expect(resAnon.json().code).toBe('PRIVATE_ACCOUNT');

      // Stranger (Dave)
      const resStranger = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userBob}/followers`,
        headers: { 'x-user-id': userDave },
      });
      expect(resStranger.statusCode).toBe(403);
      expect(resStranger.json().code).toBe('PRIVATE_ACCOUNT');
    });

    it('private channel followers list is 200 for channel owner and approved follower', async () => {
      // Owner (Bob)
      const resOwner = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userBob}/followers`,
        headers: { 'x-user-id': userBob },
      });
      expect(resOwner.statusCode).toBe(200);
      expect(resOwner.json().items.length).toBe(1);

      // Approved Follower (Charlie)
      const resFollower = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userBob}/followers`,
        headers: { 'x-user-id': userCharlie },
      });
      expect(resFollower.statusCode).toBe(200);
      expect(resFollower.json().items.length).toBe(1);
    });

    it('followers list excludes users in a block relation with the caller', async () => {
      // Bob views followers, but Bob blocks Charlie
      mockStore.blocks.push({
        blocker_id: userBob,
        blocked_id: userCharlie,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userBob}/followers`,
        headers: { 'x-user-id': userBob },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items.length).toBe(0);
    });
  });

  describe('5. Relationships endpoint (getRelationship)', () => {
    it('returns relationship flags accurately without leaking blocked_by', async () => {
      // Charlie follows Alice
      mockStore.subscriptions.push({
        subscriber_id: userCharlie,
        channel_id: userAlice,
        created_at: new Date(),
      });

      // Charlie has requested Bob
      mockStore.follow_requests.push({
        requester_id: userCharlie,
        target_id: userBob,
        created_at: new Date(),
      });

      // Alice blocks Charlie (Charlie is blocked BY Alice)
      mockStore.blocks.push({
        blocker_id: userAlice,
        blocked_id: userCharlie,
        created_at: new Date(),
      });

      // Charlie mutes Dave
      mockStore.mutes.push({
        muter_id: userCharlie,
        muted_id: userDave,
        created_at: new Date(),
      });

      // Query relationship to Alice
      const resAlice = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userAlice}/relationship`,
        headers: { 'x-user-id': userCharlie },
      });
      expect(resAlice.statusCode).toBe(200);
      const relAlice = resAlice.json();
      expect(relAlice.following).toBe(true);
      expect(relAlice.blocking).toBe(false); // Alice blocks Charlie, Charlie DOES NOT block Alice -> blocking is false! Never leaks blocked_by.

      // Query relationship to Dave
      const resDave = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userDave}/relationship`,
        headers: { 'x-user-id': userCharlie },
      });
      expect(resDave.statusCode).toBe(200);
      expect(resDave.json().muting).toBe(true);

      // Querying yourself returns 400 CANNOT_QUERY_SELF
      const resSelf = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userCharlie}/relationship`,
        headers: { 'x-user-id': userCharlie },
      });
      expect(resSelf.statusCode).toBe(400);
      expect(resSelf.json().code).toBe('CANNOT_QUERY_SELF');
    });
  });

  describe('6. Blocks: bidirectional effects and limits', () => {
    it('blocking a user deletes subscriptions both ways and emits social.subscription.changed', async () => {
      mockStore.subscriptions.push(
        { subscriber_id: userAlice, channel_id: userBob, created_at: new Date() },
        { subscriber_id: userBob, channel_id: userAlice, created_at: new Date() },
      );
      mockStore.channels.find((c) => c.id === userAlice)!.subscriber_count = 1;
      mockStore.channels.find((c) => c.id === userBob)!.subscriber_count = 1;

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/me/blocks/${userBob}`,
        headers: { 'x-user-id': userAlice },
      });

      expect(res.statusCode).toBe(204);
      expect(mockStore.subscriptions.length).toBe(0);
      expect(mockStore.blocks.length).toBe(1);

      // Two unsubscription outbox events
      const events = mockStore.outbox.filter((o) => o.subject === 'social.subscription.changed');
      expect(events.length).toBe(2);
      expect((events[0].payload as any).data.subscribed).toBe(false);
      expect((events[1].payload as any).data.subscribed).toBe(false);
    });

    it('unblocking a user deletes the block without restoring subscriptions', async () => {
      mockStore.blocks.push({
        blocker_id: userAlice,
        blocked_id: userBob,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/me/blocks/${userBob}`,
        headers: { 'x-user-id': userAlice },
      });

      expect(res.statusCode).toBe(204);
      expect(mockStore.blocks.length).toBe(0);
      expect(mockStore.subscriptions.length).toBe(0);
    });

    it('blocking self returns 400 CANNOT_BLOCK_SELF', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/me/blocks/${userAlice}`,
        headers: { 'x-user-id': userAlice },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('CANNOT_BLOCK_SELF');
    });

    it('block list limit of 1000 returns 409 LIMIT_REACHED', async () => {
      for (let i = 0; i < 1000; i++) {
        mockStore.blocks.push({
          blocker_id: userAlice,
          blocked_id: `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b${String(i + 100).padStart(4, '0')}`,
          created_at: new Date(),
        });
      }

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/me/blocks/${userCharlie}`,
        headers: { 'x-user-id': userAlice },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('LIMIT_REACHED');
    });
  });

  describe('7. Mutes: limits and listing', () => {
    it('muting and unmuting works', async () => {
      const resMute = await app.inject({
        method: 'PUT',
        url: `/v1/me/mutes/${userCharlie}`,
        headers: { 'x-user-id': userAlice },
      });
      expect(resMute.statusCode).toBe(204);
      expect(mockStore.mutes.length).toBe(1);

      const resList = await app.inject({
        method: 'GET',
        url: '/v1/me/mutes',
        headers: { 'x-user-id': userAlice },
      });
      expect(resList.statusCode).toBe(200);
      expect(resList.json().items.length).toBe(1);
      expect(resList.json().items[0].user.id).toBe(userCharlie);
      expect(resList.json().items[0].since).toBeDefined();

      const resUnmute = await app.inject({
        method: 'DELETE',
        url: `/v1/me/mutes/${userCharlie}`,
        headers: { 'x-user-id': userAlice },
      });
      expect(resUnmute.statusCode).toBe(204);
      expect(mockStore.mutes.length).toBe(0);
    });

    it('muting self returns 400 CANNOT_MUTE_SELF', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/me/mutes/${userAlice}`,
        headers: { 'x-user-id': userAlice },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('CANNOT_MUTE_SELF');
    });

    it('mute limit of 1000 returns 409 LIMIT_REACHED', async () => {
      for (let i = 0; i < 1000; i++) {
        mockStore.mutes.push({
          muter_id: userAlice,
          muted_id: `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b${String(i + 100).padStart(4, '0')}`,
          created_at: new Date(),
        });
      }

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/me/mutes/${userCharlie}`,
        headers: { 'x-user-id': userAlice },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('LIMIT_REACHED');
    });
  });

  describe('8. Comment Block Checks & Interaction Blocking', () => {
    it('createComment returns 403 INTERACTION_BLOCKED when caller is in a block relation with video owner', async () => {
      mockStore.blocks.push({
        blocker_id: userAlice, // Video owner Alice blocks Charlie
        blocked_id: userCharlie,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/videos/${videoId}/comments`,
        headers: { 'x-user-id': userCharlie },
        payload: { body: 'Hello world' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('INTERACTION_BLOCKED');
    });

    it('createComment returns 403 INTERACTION_BLOCKED when caller is in a block relation with parent comment author', async () => {
      const parentCommentId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9020';
      mockStore.comments.push({
        id: parentCommentId,
        video_id: videoId,
        author_id: userDave,
        parent_id: null,
        body: 'Parent comment',
        status: 'VISIBLE',
        reply_count: 0,
        created_at: new Date(),
        edited_at: null,
        updated_at: new Date(),
      });

      // Charlie and Dave are in a block relation
      mockStore.blocks.push({
        blocker_id: userCharlie,
        blocked_id: userDave,
        created_at: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/videos/${videoId}/comments`,
        headers: { 'x-user-id': userCharlie },
        payload: { body: 'Reply text', parent_id: parentCommentId },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('INTERACTION_BLOCKED');
    });
  });
});
