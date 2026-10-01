import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';

describe('Playlists & Watch Later Unit Tests (Task PL1 / ADR-024)', () => {
  let app: FastifyInstance;
  let store: MockStore;

  const userA = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
  const userB = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002';
  const video1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9011';
  const video2 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9012';
  const video3 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9013';
  const videoHidden = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9014';
  const videoPrivateB = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9015';
  const videoPrivateA = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9016';

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
    );

    // Populate channels
    store.channels.push({ id: userA, subscriber_count: 5 }, { id: userB, subscriber_count: 0 });

    // Populate videos
    store.videos.push(
      {
        id: video1,
        owner_id: userA,
        like_count: 10,
        comment_count: 2,
        hidden: false,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T00:00:00Z'),
      },
      {
        id: video2,
        owner_id: userA,
        like_count: 5,
        comment_count: 1,
        hidden: false,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T01:00:00Z'),
      },
      {
        id: video3,
        owner_id: userA,
        like_count: 1,
        comment_count: 0,
        hidden: false,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T02:00:00Z'),
      },
      {
        id: videoHidden,
        owner_id: userA,
        like_count: 0,
        comment_count: 0,
        hidden: true,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T03:00:00Z'),
      },
      {
        id: videoPrivateB,
        owner_id: userB,
        like_count: 0,
        comment_count: 0,
        hidden: false,
        visibility: 'PRIVATE',
        created_at: new Date('2026-10-01T04:00:00Z'),
      },
      {
        id: videoPrivateA,
        owner_id: userA,
        like_count: 0,
        comment_count: 0,
        hidden: false,
        visibility: 'PRIVATE',
        created_at: new Date('2026-10-01T05:00:00Z'),
      },
    );

    app = await buildApp({
      env,
      db,
      rateLimiter,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------
  // 1. POST /v1/playlists
  // -------------------------------------------------------------
  describe('POST /v1/playlists', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/playlists',
        payload: { title: 'My Playlist' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when title is missing or empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/playlists',
        headers: { 'x-user-id': userA },
        payload: { title: '   ' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TITLE');
    });

    it('returns 400 when title is too long (> 150 chars)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/playlists',
        headers: { 'x-user-id': userA },
        payload: { title: 'a'.repeat(151) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TITLE');
    });

    it('returns 400 when visibility is invalid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/playlists',
        headers: { 'x-user-id': userA },
        payload: { title: 'Test', visibility: 'SECRET' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_VISIBILITY');
    });

    it('creates a playlist with default PRIVATE visibility and 0 item_count', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/playlists',
        headers: { 'x-user-id': userA },
        payload: { title: 'Chill Vibes', description: 'Relaxing songs' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.title).toBe('Chill Vibes');
      expect(body.description).toBe('Relaxing songs');
      expect(body.visibility).toBe('PRIVATE');
      expect(body.kind).toBe('REGULAR');
      expect(body.item_count).toBe(0);
      expect(body.owner.id).toBe(userA);
      expect(body.owner.handle).toBe('alice');
      expect(body.owner.avatar_url).toBe('https://media.winkey.vn/avatars/alice.jpg');
      expect(typeof body.id).toBe('string');
      expect(typeof body.created_at).toBe('string');
      expect(typeof body.updated_at).toBe('string');
    });

    it('creates a playlist with explicit PUBLIC visibility', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/playlists',
        headers: { 'x-user-id': userA },
        payload: { title: 'Coding Beats', visibility: 'PUBLIC' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.title).toBe('Coding Beats');
      expect(body.visibility).toBe('PUBLIC');
    });

    it('returns 409 PLAYLIST_LIMIT when user already has 200 playlists', async () => {
      // Fill userA playlists to 200
      for (let i = 0; i < 200; i++) {
        store.playlists.push({
          id: `0192f5e4-7c1a-7b3e-9d2a-${String(i).padStart(12, '0')}`,
          owner_id: userA,
          kind: 'REGULAR',
          title: `Playlist ${i}`,
          description: '',
          visibility: 'PUBLIC',
          item_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }

      const res = await app.inject({
        method: 'POST',
        url: '/v1/playlists',
        headers: { 'x-user-id': userA },
        payload: { title: 'One more' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('PLAYLIST_LIMIT');
    });
  });

  // -------------------------------------------------------------
  // 2. GET /v1/playlists/:playlist_id
  // -------------------------------------------------------------
  describe('GET /v1/playlists/:playlist_id', () => {
    const plPublic = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0001';
    const plUnlisted = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0002';
    const plPrivate = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0003';
    const plWatchLater = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0004';

    beforeEach(() => {
      store.playlists.push(
        {
          id: plPublic,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Public List',
          description: 'Desc',
          visibility: 'PUBLIC',
          item_count: 2,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: plUnlisted,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Unlisted List',
          description: '',
          visibility: 'UNLISTED',
          item_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: plPrivate,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Private List',
          description: '',
          visibility: 'PRIVATE',
          item_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: plWatchLater,
          owner_id: userA,
          kind: 'WATCH_LATER',
          title: 'Xem sau',
          description: '',
          visibility: 'PRIVATE',
          item_count: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
      );
    });

    it('returns 400 on invalid UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/playlists/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_ID');
    });

    it('returns 404 for non-existent playlist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/playlists/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('returns 200 for PUBLIC playlist without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPublic}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const body = res.json();
      expect(body.id).toBe(plPublic);
      expect(body.title).toBe('Public List');
    });

    it('returns 200 for UNLISTED playlist without auth (accessible with link)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plUnlisted}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().visibility).toBe('UNLISTED');
    });

    it('returns 404 (never 403) for PRIVATE playlist if caller is unauthenticated or not owner', async () => {
      const resAnon = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPrivate}`,
      });
      expect(resAnon.statusCode).toBe(404);
      expect(resAnon.json().code).toBe('PLAYLIST_NOT_FOUND');

      const resOtherUser = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPrivate}`,
        headers: { 'x-user-id': userB },
      });
      expect(resOtherUser.statusCode).toBe(404);
      expect(resOtherUser.json().code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('returns 200 for PRIVATE playlist when caller is owner', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPrivate}`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(plPrivate);
    });

    it('returns 404 for WATCH_LATER playlist when caller is not owner', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plWatchLater}`,
        headers: { 'x-user-id': userB },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('returns 200 for WATCH_LATER playlist when caller is owner', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plWatchLater}`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().kind).toBe('WATCH_LATER');
    });
  });

  // -------------------------------------------------------------
  // 3. PATCH /v1/playlists/:playlist_id
  // -------------------------------------------------------------
  describe('PATCH /v1/playlists/:playlist_id', () => {
    const plId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0010';
    const plWlId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0011';

    beforeEach(() => {
      store.playlists.push(
        {
          id: plId,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Initial Title',
          description: 'Initial Desc',
          visibility: 'PRIVATE',
          item_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: plWlId,
          owner_id: userA,
          kind: 'WATCH_LATER',
          title: 'Xem sau',
          description: '',
          visibility: 'PRIVATE',
          item_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        },
      );
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/playlists/${plId}`,
        payload: { title: 'New' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when user is not owner', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/playlists/${plId}`,
        headers: { 'x-user-id': userB },
        payload: { title: 'Hacked' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('returns 409 WATCH_LATER_IMMUTABLE when editing watch later', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/playlists/${plWlId}`,
        headers: { 'x-user-id': userA },
        payload: { title: 'Watch Earlier' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('WATCH_LATER_IMMUTABLE');
    });

    it('returns 400 when body has no fields to update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/playlists/${plId}`,
        headers: { 'x-user-id': userA },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_BODY');
    });

    it('returns 400 when updating with empty title', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/playlists/${plId}`,
        headers: { 'x-user-id': userA },
        payload: { title: '   ' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TITLE');
    });

    it('updates title, description, and visibility successfully', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/playlists/${plId}`,
        headers: { 'x-user-id': userA },
        payload: {
          title: 'Updated Title',
          description: 'Updated Description',
          visibility: 'PUBLIC',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.title).toBe('Updated Title');
      expect(body.description).toBe('Updated Description');
      expect(body.visibility).toBe('PUBLIC');
    });
  });

  // -------------------------------------------------------------
  // 4. DELETE /v1/playlists/:playlist_id
  // -------------------------------------------------------------
  describe('DELETE /v1/playlists/:playlist_id', () => {
    const plId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0020';
    const plWlId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0021';

    beforeEach(() => {
      store.playlists.push(
        {
          id: plId,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'To Delete',
          description: '',
          visibility: 'PRIVATE',
          item_count: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: plWlId,
          owner_id: userA,
          kind: 'WATCH_LATER',
          title: 'Xem sau',
          description: '',
          visibility: 'PRIVATE',
          item_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        },
      );
      store.playlist_items.push({
        playlist_id: plId,
        video_id: video1,
        position: 1048576,
        added_at: new Date(),
      });
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/playlists/${plId}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when not owner', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/playlists/${plId}`,
        headers: { 'x-user-id': userB },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('returns 409 WATCH_LATER_IMMUTABLE when trying to delete watch later', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/playlists/${plWlId}`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('WATCH_LATER_IMMUTABLE');
    });

    it('deletes playlist and cascades items with 204', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/playlists/${plId}`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(204);
      expect(store.playlists.some((p) => p.id === plId)).toBe(false);
      expect(store.playlist_items.some((pi) => pi.playlist_id === plId)).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // 5. POST /v1/playlists/:playlist_id/items - Add item
  // -------------------------------------------------------------
  describe('POST /v1/playlists/:playlist_id/items', () => {
    const plId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0030';

    beforeEach(() => {
      store.playlists.push({
        id: plId,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Playlist Items Test',
        description: '',
        visibility: 'PUBLIC',
        item_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      });
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        payload: { video_id: video1 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when playlist does not exist or caller is not owner', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userB },
        payload: { video_id: video1 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('returns 404 VIDEO_NOT_FOUND when video does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 404 VIDEO_NOT_FOUND when video is hidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: videoHidden },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 404 VIDEO_NOT_FOUND when video is PRIVATE and belongs to someone else', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: videoPrivateB },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('VIDEO_NOT_FOUND');
    });

    it('adds first item at position 2^20 (1048576) with 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: video1 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.video_id).toBe(video1);
      expect(body.position).toBe(1048576);
      expect(store.playlists.find((p) => p.id === plId)?.item_count).toBe(1);
    });

    it('adds second item at position max_position + 2^20 (2097152) with 201', async () => {
      await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: video1 },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: video2 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.video_id).toBe(video2);
      expect(body.position).toBe(2097152);
      expect(store.playlists.find((p) => p.id === plId)?.item_count).toBe(2);
    });

    it('is idempotent: adding an existing item returns 200 without changing position or item_count', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: video1 },
      });
      expect(res1.statusCode).toBe(201);

      const res2 = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: video1 },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().video_id).toBe(video1);
      expect(res2.json().position).toBe(1048576);
      expect(store.playlists.find((p) => p.id === plId)?.item_count).toBe(1);
    });

    it('returns 409 PLAYLIST_FULL when playlist already has 5000 items', async () => {
      const pl = store.playlists.find((p) => p.id === plId)!;
      pl.item_count = 5000;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items`,
        headers: { 'x-user-id': userA },
        payload: { video_id: video1 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('PLAYLIST_FULL');
    });
  });

  // -------------------------------------------------------------
  // 6. DELETE /v1/playlists/:playlist_id/items/:video_id
  // -------------------------------------------------------------
  describe('DELETE /v1/playlists/:playlist_id/items/:video_id', () => {
    const plId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0040';

    beforeEach(() => {
      store.playlists.push({
        id: plId,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Delete Item Test',
        description: '',
        visibility: 'PUBLIC',
        item_count: 1,
        created_at: new Date(),
        updated_at: new Date(),
      });
      store.playlist_items.push({
        playlist_id: plId,
        video_id: video1,
        position: 1048576,
        added_at: new Date(),
      });
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/playlists/${plId}/items/${video1}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when playlist not found or caller not owner', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/playlists/${plId}/items/${video1}`,
        headers: { 'x-user-id': userB },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('removes item with 204 and decrements item_count', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/playlists/${plId}/items/${video1}`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(204);
      expect(
        store.playlist_items.some((pi) => pi.playlist_id === plId && pi.video_id === video1),
      ).toBe(false);
      expect(store.playlists.find((p) => p.id === plId)?.item_count).toBe(0);
    });

    it('is idempotent: deleting a non-existent item still returns 204', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/playlists/${plId}/items/${video2}`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(204);
      expect(store.playlists.find((p) => p.id === plId)?.item_count).toBe(1);
    });
  });

  // -------------------------------------------------------------
  // 7. POST /v1/playlists/:playlist_id/items/:video_id/move
  // -------------------------------------------------------------
  describe('POST /v1/playlists/:playlist_id/items/:video_id/move', () => {
    const plId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0050';

    beforeEach(() => {
      store.playlists.push({
        id: plId,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Move Test',
        description: '',
        visibility: 'PUBLIC',
        item_count: 3,
        created_at: new Date(),
        updated_at: new Date(),
      });
      store.playlist_items.push(
        { playlist_id: plId, video_id: video1, position: 1048576, added_at: new Date() },
        { playlist_id: plId, video_id: video2, position: 2097152, added_at: new Date() },
        { playlist_id: plId, video_id: video3, position: 3145728, added_at: new Date() },
      );
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items/${video3}/move`,
        payload: { before_video_id: video1 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when before_video_id is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items/${video3}/move`,
        headers: { 'x-user-id': userA },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_BODY');
    });

    it('returns 200 no-op when moving before self', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items/${video2}/move`,
        headers: { 'x-user-id': userA },
        payload: { before_video_id: video2 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().position).toBe(2097152);
    });

    it('moves item to front (before first item) at position floor(first.position / 2)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items/${video3}/move`,
        headers: { 'x-user-id': userA },
        payload: { before_video_id: video1 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.video_id).toBe(video3);
      expect(body.position).toBe(Math.floor(1048576 / 2)); // 524288
    });

    it('moves item to end (before_video_id = null) at position last.position + 2^20', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items/${video1}/move`,
        headers: { 'x-user-id': userA },
        payload: { before_video_id: null },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.video_id).toBe(video1);
      expect(body.position).toBe(3145728 + 1048576); // 4194304
    });

    it('moves item between two items at midpoint position', async () => {
      // video1 (1048576), video2 (2097152), video3 (3145728)
      // Move video3 before video2 (between video1 and video2)
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items/${video3}/move`,
        headers: { 'x-user-id': userA },
        payload: { before_video_id: video2 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.video_id).toBe(video3);
      expect(body.position).toBe(Math.floor((1048576 + 2097152) / 2)); // 1572864
    });

    it('triggers sparse renumbering when no integer gap exists', async () => {
      // Setup tight positions: video1 at 1, video2 at 2, video3 at 10
      const it1 = store.playlist_items.find(
        (i) => i.playlist_id === plId && i.video_id === video1,
      )!;
      const it2 = store.playlist_items.find(
        (i) => i.playlist_id === plId && i.video_id === video2,
      )!;
      it1.position = 1;
      it2.position = 2;

      // Move video3 before video2 -> posAfter(2) - posBefore(1) = 1 <= 1 -> triggers renumbering
      const res = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${plId}/items/${video3}/move`,
        headers: { 'x-user-id': userA },
        payload: { before_video_id: video2 },
      });
      expect(res.statusCode).toBe(200);

      // In renumbered order: video1 (pos 1), video3 (pos 2), video2 (pos 3)
      // With step 2^20: video1 = 1048576, video3 = 2097152, video2 = 3145728
      const body = res.json();
      expect(body.video_id).toBe(video3);
      expect(body.position).toBe(2097152);
    });
  });

  // -------------------------------------------------------------
  // 8. GET /v1/playlists/:playlist_id/items - List items
  // -------------------------------------------------------------
  describe('GET /v1/playlists/:playlist_id/items', () => {
    const plPublic = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0060';
    const plPrivate = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0061';

    beforeEach(() => {
      store.playlists.push(
        {
          id: plPublic,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Public Items Test',
          description: '',
          visibility: 'PUBLIC',
          item_count: 3,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: plPrivate,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Private Items Test',
          description: '',
          visibility: 'PRIVATE',
          item_count: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
      );

      store.playlist_items.push(
        { playlist_id: plPublic, video_id: video1, position: 1048576, added_at: new Date() },
        { playlist_id: plPublic, video_id: videoPrivateA, position: 2097152, added_at: new Date() },
        { playlist_id: plPublic, video_id: videoHidden, position: 3145728, added_at: new Date() },
        { playlist_id: plPublic, video_id: video2, position: 4194304, added_at: new Date() },
        { playlist_id: plPrivate, video_id: video1, position: 1048576, added_at: new Date() },
      );
    });

    it('returns 404 for PRIVATE playlist if caller is not owner', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPrivate}/items`,
        headers: { 'x-user-id': userB },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('filters out private (non-owned) and hidden videos for non-owner caller at read time', async () => {
      // userB requests public playlist containing video1, videoPrivateA, videoHidden, video2
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPublic}/items`,
        headers: { 'x-user-id': userB },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // videoPrivateA and videoHidden should both be excluded for userB!
      expect(body.items).toHaveLength(2);
      expect(body.items.map((i: any) => i.video_id)).toEqual([video1, video2]);
    });

    it('includes private videos if caller owns the video (hidden videos are never returned)', async () => {
      // userA owns videoPrivateA and videoHidden. videoPrivateA is included, videoHidden is excluded.
      const res = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPublic}/items`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(3);
      expect(body.items.map((i: any) => i.video_id)).toEqual([video1, videoPrivateA, video2]);
    });

    it('supports keyset pagination with cursor and limit', async () => {
      // Query limit 1
      const res1 = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPublic}/items?limit=1`,
        headers: { 'x-user-id': userB },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = res1.json();
      expect(body1.items).toHaveLength(1);
      expect(body1.items[0].video_id).toBe(video1);
      expect(body1.next_cursor).toBeTruthy();

      // Query next page with cursor
      const res2 = await app.inject({
        method: 'GET',
        url: `/v1/playlists/${plPublic}/items?limit=1&cursor=${body1.next_cursor}`,
        headers: { 'x-user-id': userB },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = res2.json();
      expect(body2.items).toHaveLength(1);
      expect(body2.items[0].video_id).toBe(video2);
      expect(body2.next_cursor).toBeNull();
    });
  });

  // -------------------------------------------------------------
  // 9. GET /v1/channels/:channel_id/playlists - Channel playlists
  // -------------------------------------------------------------
  describe('GET /v1/channels/:channel_id/playlists', () => {
    beforeEach(() => {
      // User A playlists
      store.playlists.push(
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0071',
          owner_id: userA,
          kind: 'WATCH_LATER',
          title: 'Xem sau',
          description: '',
          visibility: 'PRIVATE',
          item_count: 5,
          created_at: new Date('2026-10-01T00:00:00Z'),
          updated_at: new Date('2026-10-01T00:00:00Z'),
        },
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0072',
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Public Playlist 1',
          description: '',
          visibility: 'PUBLIC',
          item_count: 2,
          created_at: new Date('2026-10-01T01:00:00Z'),
          updated_at: new Date('2026-10-01T01:00:00Z'),
        },
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0073',
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Unlisted Playlist',
          description: '',
          visibility: 'UNLISTED',
          item_count: 1,
          created_at: new Date('2026-10-01T02:00:00Z'),
          updated_at: new Date('2026-10-01T02:00:00Z'),
        },
        {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0074',
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Private Playlist',
          description: '',
          visibility: 'PRIVATE',
          item_count: 0,
          created_at: new Date('2026-10-01T03:00:00Z'),
          updated_at: new Date('2026-10-01T03:00:00Z'),
        },
      );
    });

    it('returns only PUBLIC regular playlists for anonymous or other users', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userA}/playlists`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe('Public Playlist 1');
      expect(body.items[0].visibility).toBe('PUBLIC');
    });

    it('returns all playlists with WATCH_LATER pinned first for the channel owner', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/channels/${userA}/playlists`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(4);
      expect(body.items[0].kind).toBe('WATCH_LATER');
      expect(body.items[0].title).toBe('Xem sau');
    });
  });

  // -------------------------------------------------------------
  // 10. GET /v1/videos/:video_id/playlist-membership
  // -------------------------------------------------------------
  describe('GET /v1/videos/:video_id/playlist-membership', () => {
    const plA1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0081';
    const plA2 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0082';
    const plB1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0083';

    beforeEach(() => {
      store.playlists.push(
        {
          id: plA1,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'A1',
          description: '',
          visibility: 'PUBLIC',
          item_count: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: plA2,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'A2',
          description: '',
          visibility: 'PRIVATE',
          item_count: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: plB1,
          owner_id: userB,
          kind: 'REGULAR',
          title: 'B1',
          description: '',
          visibility: 'PUBLIC',
          item_count: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
      );

      // video1 is in plA1 and plB1
      store.playlist_items.push(
        {
          playlist_id: plA1,
          video_id: video1,
          position: 1048576,
          added_at: new Date('2026-10-01T01:00:00Z'),
        },
        {
          playlist_id: plB1,
          video_id: video1,
          position: 1048576,
          added_at: new Date('2026-10-01T02:00:00Z'),
        },
      );
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/videos/${video1}/playlist-membership`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns caller-owned playlist IDs containing the video', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/videos/${video1}/playlist-membership`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().playlist_ids).toEqual([plA1]);
    });

    it('returns empty array when video is not in any of caller playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/videos/${video2}/playlist-membership`,
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().playlist_ids).toEqual([]);
    });
  });

  // -------------------------------------------------------------
  // 11. GET /v1/me/watch-later
  // -------------------------------------------------------------
  describe('GET /v1/me/watch-later', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/watch-later',
      });
      expect(res.statusCode).toBe(401);
    });

    it('lazily creates WATCH_LATER playlist with Vietnamese title "Xem sau" and PRIVATE visibility', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/watch-later',
        headers: { 'x-user-id': userA },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.kind).toBe('WATCH_LATER');
      expect(body.title).toBe('Xem sau');
      expect(body.visibility).toBe('PRIVATE');
      expect(body.item_count).toBe(0);
      expect(body.owner.id).toBe(userA);

      // Subsequent call returns the same playlist
      const res2 = await app.inject({
        method: 'GET',
        url: '/v1/me/watch-later',
        headers: { 'x-user-id': userA },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().id).toBe(body.id);
    });

    it('does not fail even if user already has 200 regular playlists', async () => {
      for (let i = 0; i < 200; i++) {
        store.playlists.push({
          id: `0192f5e4-7c1a-7b3e-9d2a-${String(i).padStart(12, '0')}`,
          owner_id: userB,
          kind: 'REGULAR',
          title: `Playlist ${i}`,
          description: '',
          visibility: 'PUBLIC',
          item_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }

      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/watch-later',
        headers: { 'x-user-id': userB },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().kind).toBe('WATCH_LATER');
    });
  });
});
