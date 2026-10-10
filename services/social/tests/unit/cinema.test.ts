import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';

describe('Cinema Catalogue & Series Unit Tests (Task CIN2 / ADR-035)', () => {
  let app: FastifyInstance;
  let store: MockStore;

  const userA = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
  const userB = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002';

  const videoA1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9011';
  const videoA2 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9012';
  const videoA3 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9013';
  const videoAHidden = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9014';
  const videoAPrivate = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9015';
  const videoAUnlisted = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9016';
  const videoB1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9021';

  const series1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9101';
  const series2 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9102';
  const seriesUnlisted = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9103';

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
      { id: userA, handle: 'creator_a', display_name: 'Creator A', avatar_key: 'avatars/a.jpg' },
      { id: userB, handle: 'creator_b', display_name: 'Creator B', avatar_key: null },
    );

    // Populate channels
    store.channels.push({ id: userA, subscriber_count: 100 }, { id: userB, subscriber_count: 10 });

    // Populate videos
    store.videos.push(
      {
        id: videoA1,
        owner_id: userA,
        like_count: 10,
        comment_count: 1,
        hidden: false,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T10:00:00Z'),
      },
      {
        id: videoA2,
        owner_id: userA,
        like_count: 20,
        comment_count: 2,
        hidden: false,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T11:00:00Z'),
      },
      {
        id: videoA3,
        owner_id: userA,
        like_count: 30,
        comment_count: 3,
        hidden: false,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T12:00:00Z'),
      },
      {
        id: videoAHidden,
        owner_id: userA,
        like_count: 0,
        comment_count: 0,
        hidden: true,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T13:00:00Z'),
      },
      {
        id: videoAPrivate,
        owner_id: userA,
        like_count: 0,
        comment_count: 0,
        hidden: false,
        visibility: 'PRIVATE',
        created_at: new Date('2026-10-01T14:00:00Z'),
      },
      {
        id: videoAUnlisted,
        owner_id: userA,
        like_count: 0,
        comment_count: 0,
        hidden: false,
        visibility: 'UNLISTED',
        created_at: new Date('2026-10-01T15:00:00Z'),
      },
      {
        id: videoB1,
        owner_id: userB,
        like_count: 5,
        comment_count: 0,
        hidden: false,
        visibility: 'PUBLIC',
        created_at: new Date('2026-10-01T16:00:00Z'),
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
  // 1. GET /v1/cinema/catalog
  // -------------------------------------------------------------
  describe('GET /v1/cinema/catalog', () => {
    it('sets Cache-Control: public, max-age=60', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('rejects invalid kind with 400 INVALID_KIND', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?kind=invalid',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_KIND');
    });

    it('rejects invalid limit with 400 INVALID_LIMIT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?limit=50', // max 48
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_LIMIT');

      const resZero = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?limit=0',
      });
      expect(resZero.statusCode).toBe(400);
      expect(resZero.json().code).toBe('INVALID_LIMIT');
    });

    it('rejects invalid cursor with 400 INVALID_CURSOR', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?cursor=not-a-cursor',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_CURSOR');
    });

    it('returns standalone videos when there are no series', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog',
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.items).toBeDefined();

      // Only PUBLIC non-hidden videos: videoB1, videoA3, videoA2, videoA1 (in reverse created_at order)
      expect(data.items).toHaveLength(4);
      expect(data.items[0]).toEqual({
        kind: 'VIDEO',
        video_id: videoB1,
        added_at: '2026-10-01T16:00:00.000Z',
      });
      expect(data.items[1].video_id).toBe(videoA3);
      expect(data.items[2].video_id).toBe(videoA2);
      expect(data.items[3].video_id).toBe(videoA1);
    });

    it('interleaves series and standalone videos with kind=all, and excludes series episodes from standalone videos', async () => {
      // Create Series 1 with videoA1 and videoA2
      store.playlists.push({
        id: series1,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Epic Series A',
        description: 'First series',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 2,
        created_at: new Date('2026-10-01T10:00:00Z'),
        updated_at: new Date('2026-10-01T17:00:00Z'),
      });

      store.playlist_items.push(
        {
          playlist_id: series1,
          video_id: videoA1,
          position: 1048576,
          added_at: new Date('2026-10-01T10:30:00Z'),
        },
        {
          playlist_id: series1,
          video_id: videoA2,
          position: 2097152,
          added_at: new Date('2026-10-01T17:00:00Z'), // newest episode added at 17:00
        },
      );

      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?kind=all',
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items;

      // Series 1 newest playable episode was added at 17:00
      // Standalone videos remaining: videoB1 (16:00), videoA3 (12:00)
      // videoA1 and videoA2 are episodes of public series1, so they are excluded from standalone
      expect(items).toHaveLength(3);

      expect(items[0].kind).toBe('SERIES');
      expect(items[0].series.playlist_id).toBe(series1);
      expect(items[0].series.title).toBe('Epic Series A');
      expect(items[0].series.episode_count).toBe(2);
      expect(items[0].series.first_video_id).toBe(videoA1);
      expect(items[0].series.owner.handle).toBe('creator_a');
      expect(items[0].series.updated_at).toBe('2026-10-01T17:00:00.000Z');

      expect(items[1].kind).toBe('VIDEO');
      expect(items[1].video_id).toBe(videoB1);

      expect(items[2].kind).toBe('VIDEO');
      expect(items[2].video_id).toBe(videoA3);
    });

    it('filters kind=series only', async () => {
      store.playlists.push({
        id: series1,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Epic Series A',
        description: 'First series',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 1,
        created_at: new Date('2026-10-01T10:00:00Z'),
        updated_at: new Date('2026-10-01T10:30:00Z'),
      });
      store.playlist_items.push({
        playlist_id: series1,
        video_id: videoA1,
        position: 1048576,
        added_at: new Date('2026-10-01T10:30:00Z'),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?kind=series',
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('SERIES');
      expect(items[0].series.playlist_id).toBe(series1);
    });

    it('filters kind=video only', async () => {
      store.playlists.push({
        id: series1,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Epic Series A',
        description: 'First series',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 1,
        created_at: new Date('2026-10-01T10:00:00Z'),
        updated_at: new Date('2026-10-01T10:30:00Z'),
      });
      store.playlist_items.push({
        playlist_id: series1,
        video_id: videoA1,
        position: 1048576,
        added_at: new Date('2026-10-01T10:30:00Z'),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?kind=video',
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.kind).toBe('VIDEO');
        expect(item.video_id).not.toBe(videoA1); // excluded because it's in series1
      }
    });

    it('a video in an UNLISTED series remains a standalone video in catalogue', async () => {
      store.playlists.push({
        id: seriesUnlisted,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Unlisted Series',
        description: 'Not public',
        visibility: 'UNLISTED',
        is_series: true,
        item_count: 1,
        created_at: new Date('2026-10-01T10:00:00Z'),
        updated_at: new Date('2026-10-01T10:30:00Z'),
      });
      store.playlist_items.push({
        playlist_id: seriesUnlisted,
        video_id: videoA1,
        position: 1048576,
        added_at: new Date('2026-10-01T10:30:00Z'),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?kind=all',
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      // UNLISTED series is NOT in catalogue
      expect(items.some((i: { kind: string; video_id?: string }) => i.kind === 'SERIES')).toBe(
        false,
      );
      // videoA1 is still in catalogue as VIDEO
      expect(
        items.some(
          (i: { kind: string; video_id?: string }) => i.kind === 'VIDEO' && i.video_id === videoA1,
        ),
      ).toBe(true);
    });

    it('a series with 0 playable episodes is excluded from catalogue', async () => {
      store.playlists.push({
        id: series2,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Empty Series',
        description: '',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 1,
        created_at: new Date('2026-10-01T10:00:00Z'),
        updated_at: new Date('2026-10-01T10:30:00Z'),
      });
      // Add hidden video to series2
      store.playlist_items.push({
        playlist_id: series2,
        video_id: videoAHidden,
        position: 1048576,
        added_at: new Date('2026-10-01T10:30:00Z'),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?kind=series',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(0);
    });

    it('supports keyset cursor pagination with limit', async () => {
      // 4 public videos available
      const page1 = await app.inject({
        method: 'GET',
        url: '/v1/cinema/catalog?kind=video&limit=2',
      });
      expect(page1.statusCode).toBe(200);
      const p1 = page1.json();
      expect(p1.items).toHaveLength(2);
      expect(p1.next_cursor).not.toBeNull();

      const page2 = await app.inject({
        method: 'GET',
        url: `/v1/cinema/catalog?kind=video&limit=2&cursor=${p1.next_cursor}`,
      });
      expect(page2.statusCode).toBe(200);
      const p2 = page2.json();
      expect(p2.items).toHaveLength(2);
      expect(p2.next_cursor).toBeNull();

      expect(p1.items[0].video_id).toBe(videoB1);
      expect(p1.items[1].video_id).toBe(videoA3);
      expect(p2.items[0].video_id).toBe(videoA2);
      expect(p2.items[1].video_id).toBe(videoA1);
    });
  });

  // -------------------------------------------------------------
  // 2. GET /v1/series/:playlist_id/episodes
  // -------------------------------------------------------------
  describe('GET /v1/series/:playlist_id/episodes', () => {
    it('sets Cache-Control: public, max-age=60', async () => {
      store.playlists.push({
        id: series1,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Series 1',
        description: 'Test',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 1,
        created_at: new Date(),
        updated_at: new Date(),
      });
      store.playlist_items.push({
        playlist_id: series1,
        video_id: videoA1,
        position: 1048576,
        added_at: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('returns 400 INVALID_ID for malformed UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/series/not-a-uuid/episodes',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_ID');
    });

    it('returns 404 SERIES_NOT_FOUND when playlist does not exist', async () => {
      const nonExistent = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999';
      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${nonExistent}/episodes`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SERIES_NOT_FOUND');
    });

    it('returns 404 SERIES_NOT_FOUND when playlist is not PUBLIC or not a series', async () => {
      store.playlists.push(
        {
          id: seriesUnlisted,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Unlisted',
          description: '',
          visibility: 'UNLISTED',
          is_series: true,
          item_count: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: series2,
          owner_id: userA,
          kind: 'REGULAR',
          title: 'Normal list',
          description: '',
          visibility: 'PUBLIC',
          is_series: false,
          item_count: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
      );

      const resUnlisted = await app.inject({
        method: 'GET',
        url: `/v1/series/${seriesUnlisted}/episodes`,
      });
      expect(resUnlisted.statusCode).toBe(404);
      expect(resUnlisted.json().code).toBe('SERIES_NOT_FOUND');

      const resNotSeries = await app.inject({
        method: 'GET',
        url: `/v1/series/${series2}/episodes`,
      });
      expect(resNotSeries.statusCode).toBe(404);
      expect(resNotSeries.json().code).toBe('SERIES_NOT_FOUND');
    });

    it('returns 404 SERIES_NOT_FOUND when playlist has 0 playable episodes', async () => {
      store.playlists.push({
        id: series1,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Empty',
        description: '',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SERIES_NOT_FOUND');
    });

    it('calculates gapless 1-based episode_number skipping non-playable videos', async () => {
      store.playlists.push({
        id: series1,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Gapless Series',
        description: 'Test numbering',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 5,
        created_at: new Date(),
        updated_at: new Date(),
      });

      // Item 1: playable (videoA1)
      // Item 2: hidden (videoAHidden) -> skipped
      // Item 3: playable (videoA2)
      // Item 4: private (videoAPrivate) -> skipped
      // Item 5: playable (videoA3)
      store.playlist_items.push(
        {
          playlist_id: series1,
          video_id: videoA1,
          position: 1048576,
          added_at: new Date('2026-10-01T10:00:00Z'),
        },
        {
          playlist_id: series1,
          video_id: videoAHidden,
          position: 2097152,
          added_at: new Date('2026-10-01T11:00:00Z'),
        },
        {
          playlist_id: series1,
          video_id: videoA2,
          position: 3145728,
          added_at: new Date('2026-10-01T12:00:00Z'),
        },
        {
          playlist_id: series1,
          video_id: videoAPrivate,
          position: 4194304,
          added_at: new Date('2026-10-01T13:00:00Z'),
        },
        {
          playlist_id: series1,
          video_id: videoA3,
          position: 5242880,
          added_at: new Date('2026-10-01T14:00:00Z'),
        },
      );

      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes`,
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();

      expect(data.series.episode_count).toBe(3);
      expect(data.series.first_video_id).toBe(videoA1);
      expect(data.series.updated_at).toBe('2026-10-01T14:00:00.000Z');

      expect(data.items).toHaveLength(3);
      expect(data.items[0]).toEqual({ video_id: videoA1, episode_number: 1 });
      expect(data.items[1]).toEqual({ video_id: videoA2, episode_number: 2 });
      expect(data.items[2]).toEqual({ video_id: videoA3, episode_number: 3 });
    });
  });

  // -------------------------------------------------------------
  // 3. GET /v1/series/:playlist_id/episodes/:video_id
  // -------------------------------------------------------------
  describe('GET /v1/series/:playlist_id/episodes/:video_id', () => {
    beforeEach(() => {
      store.playlists.push({
        id: series1,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Three Episodes',
        description: 'Context testing',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 3,
        created_at: new Date(),
        updated_at: new Date(),
      });

      store.playlist_items.push(
        {
          playlist_id: series1,
          video_id: videoA1,
          position: 1048576,
          added_at: new Date('2026-10-01T10:00:00Z'),
        },
        {
          playlist_id: series1,
          video_id: videoA2,
          position: 2097152,
          added_at: new Date('2026-10-01T11:00:00Z'),
        },
        {
          playlist_id: series1,
          video_id: videoA3,
          position: 3145728,
          added_at: new Date('2026-10-01T12:00:00Z'),
        },
      );
    });

    it('sets Cache-Control: public, max-age=60', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes/${videoA1}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('returns first episode context with previous_video_id null and page_cursor null', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes/${videoA1}`,
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();

      expect(data.episode_number).toBe(1);
      expect(data.previous_video_id).toBeNull();
      expect(data.next_video_id).toBe(videoA2);
      expect(data.page_cursor).toBeNull();
      expect(data.series.playlist_id).toBe(series1);
      expect(data.series.episode_count).toBe(3);
    });

    it('returns middle episode context with both previous and next video IDs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes/${videoA2}`,
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();

      expect(data.episode_number).toBe(2);
      expect(data.previous_video_id).toBe(videoA1);
      expect(data.next_video_id).toBe(videoA3);
      expect(data.page_cursor).toBeNull();
    });

    it('returns last episode context with next_video_id null', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes/${videoA3}`,
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();

      expect(data.episode_number).toBe(3);
      expect(data.previous_video_id).toBe(videoA2);
      expect(data.next_video_id).toBeNull();
      expect(data.page_cursor).toBeNull();
    });

    it('returns 404 EPISODE_NOT_FOUND when video is not in series or not playable', async () => {
      const resNotInSeries = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes/${videoB1}`,
      });
      expect(resNotInSeries.statusCode).toBe(404);
      expect(resNotInSeries.json().code).toBe('EPISODE_NOT_FOUND');

      const resHidden = await app.inject({
        method: 'GET',
        url: `/v1/series/${series1}/episodes/${videoAHidden}`,
      });
      expect(resHidden.statusCode).toBe(404);
      expect(resHidden.json().code).toBe('EPISODE_NOT_FOUND');
    });

    it('returns 404 SERIES_NOT_FOUND when series does not exist', async () => {
      const nonExistent = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999';
      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${nonExistent}/episodes/${videoA1}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SERIES_NOT_FOUND');
    });

    it('computes correct page_cursor for an episode on page 2 (when > 48 playable episodes)', async () => {
      // Create a series with 50 playable episodes
      const bigSeriesId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9199';
      store.playlists.push({
        id: bigSeriesId,
        owner_id: userA,
        kind: 'REGULAR',
        title: 'Long 50 Episode Series',
        description: 'Testing page 2 cursor',
        visibility: 'PUBLIC',
        is_series: true,
        item_count: 50,
        created_at: new Date(),
        updated_at: new Date(),
      });

      for (let i = 1; i <= 50; i++) {
        const vid = `0192f5e4-7c1a-7b3e-9d2a-${String(i).padStart(12, '0')}`;
        store.videos.push({
          id: vid,
          owner_id: userA,
          like_count: 0,
          comment_count: 0,
          hidden: false,
          visibility: 'PUBLIC',
          created_at: new Date(),
        });
        store.playlist_items.push({
          playlist_id: bigSeriesId,
          video_id: vid,
          position: i * 1000,
          added_at: new Date(),
        });
      }

      // Query episode 49 (which is on page 2 with default limit 48)
      const ep49Id = `0192f5e4-7c1a-7b3e-9d2a-${String(49).padStart(12, '0')}`;
      const res = await app.inject({
        method: 'GET',
        url: `/v1/series/${bigSeriesId}/episodes/${ep49Id}`,
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();

      expect(data.episode_number).toBe(49);
      expect(data.page_cursor).not.toBeNull();
      expect(typeof data.page_cursor).toBe('string');
    });
  });
});
