import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connect as connectNats, type NatsConnection } from 'nats';
import _Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const Ajv2020 = (_Ajv2020 as any).default ?? _Ajv2020;
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getDb } from '../../src/db/client.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { VideoProjectionConsumer } from '../../src/projection/consumer.js';
import type { FastifyInstance } from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const migrationsDir = path.join(dir, 'db', 'migrations');
    if (fs.existsSync(migrationsDir) && fs.statSync(migrationsDir).isDirectory()) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Repository root (db/migrations) not found');
}

async function applyMigrations(pool: pg.Pool, migrationsDir: string) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.up.sql'))
    .sort();

  const client = await pool.connect();
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

describe('Real PostgreSQL 17 + NATS JetStream Integration Tests (Task C1)', () => {
  let pool: pg.Pool | null = null;
  let nc: NatsConnection | null = null;
  let stopPgContainer: (() => Promise<void>) | null = null;
  let stopNatsContainer: (() => Promise<void>) | null = null;
  let app: FastifyInstance | null = null;
  let dbUrl: string | null = null;
  let natsUrl: string | null = null;
  let projectionConsumer: VideoProjectionConsumer | null = null;
  let isReady = false;

  let ajv: any;
  let validateCommentCreated: any;
  let validateLikeChanged: any;
  let validateSubChanged: any;

  beforeEach((ctx) => {
    if (!isReady) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail(
          'Real PostgreSQL 17 + NATS JetStream required by WINKEY_REQUIRE_DOCKER=1 but unavailable',
        );
      }
      ctx.skip();
    }
  });

  beforeAll(async () => {
    // 1. Setup Ajv and compile event schemas
    ajv = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as any)(ajv);

    const repoRoot = findRepoRoot();
    const eventsDir = path.join(repoRoot, 'contracts', 'events');
    const envelopeSchema = JSON.parse(
      fs.readFileSync(path.join(eventsDir, 'envelope.schema.json'), 'utf8'),
    );
    const commentCreatedSchema = JSON.parse(
      fs.readFileSync(path.join(eventsDir, 'social.comment.created.schema.json'), 'utf8'),
    );
    const likeChangedSchema = JSON.parse(
      fs.readFileSync(path.join(eventsDir, 'social.video.like_changed.schema.json'), 'utf8'),
    );
    const subChangedSchema = JSON.parse(
      fs.readFileSync(path.join(eventsDir, 'social.subscription.changed.schema.json'), 'utf8'),
    );

    ajv.addSchema(envelopeSchema, 'envelope.schema.json');
    validateCommentCreated = ajv.compile(commentCreatedSchema);
    validateLikeChanged = ajv.compile(likeChangedSchema);
    validateSubChanged = ajv.compile(subChangedSchema);

    // 2. Discover or spin up PostgreSQL 17 container
    let testDbUrl =
      process.env.TEST_DATABASE_URL ||
      (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432')
        ? process.env.DATABASE_URL
        : null);

    if (!testDbUrl) {
      try {
        const tcPg = await import('@testcontainers/postgresql');
        const pgContainer = await new tcPg.PostgreSqlContainer('postgres:17-alpine')
          .withDatabase('winkey')
          .withUsername('winkey')
          .withPassword('winkey')
          .start();
        testDbUrl = pgContainer.getConnectionUri();
        stopPgContainer = async () => {
          await pgContainer.stop();
        };
      } catch {
        // Docker unavailable
      }
    }

    // 3. Discover or spin up NATS JetStream container
    let testNatsUrl =
      process.env.TEST_NATS_URL ||
      (process.env.NATS_URL && !process.env.NATS_URL.includes('localhost:4222')
        ? process.env.NATS_URL
        : null);

    if (!testNatsUrl) {
      try {
        const { GenericContainer } = await import('testcontainers');
        const natsContainer = await new GenericContainer('nats:2.10-alpine')
          .withCommand(['-js', '-sd', '/data'])
          .withExposedPorts(4222)
          .start();
        const mappedPort = natsContainer.getMappedPort(4222);
        const host = natsContainer.getHost();
        testNatsUrl = `nats://${host}:${mappedPort}`;
        stopNatsContainer = async () => {
          await natsContainer.stop();
        };
      } catch {
        // Docker unavailable
      }
    }

    if (!testDbUrl || !testNatsUrl) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail(
          'Real PostgreSQL 17 + NATS JetStream required by WINKEY_REQUIRE_DOCKER=1 but unavailable',
        );
      }
      return;
    }

    try {
      pool = new pg.Pool({ connectionString: testDbUrl });
      await pool.query('SELECT 1');
      dbUrl = testDbUrl;

      // Apply migrations
      await applyMigrations(pool, path.join(repoRoot, 'db', 'migrations'));

      // Connect NATS
      nc = await connectNats({ servers: testNatsUrl });
      natsUrl = testNatsUrl;

      // Create stream VIDEO on NATS JetStream
      const jsm = await nc.jetstreamManager();
      try {
        await jsm.streams.add({
          name: 'VIDEO',
          subjects: ['video.>'],
        });
      } catch {
        // stream may exist
      }

      const { db } = getDb(dbUrl, pool);
      const rateLimiter = new ValkeyRateLimiter();

      projectionConsumer = new VideoProjectionConsumer({
        db,
        natsConnection: nc,
      });
      await projectionConsumer.start();

      const env = getEnv({
        DATABASE_URL: dbUrl,
        NATS_URL: natsUrl,
        NODE_ENV: 'test',
        MEDIA_BASE_URL: 'https://media.winkey.vn',
      });

      app = await buildApp({
        env,
        db,
        rateLimiter,
        natsConnection: nc,
      });

      isReady = true;
    } catch (err) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        throw err;
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (projectionConsumer) {
      await projectionConsumer.stop().catch(() => {});
    }
    if (app) {
      await app.close().catch(() => {});
    }
    if (nc) {
      await nc.drain().catch(() => {});
      await nc.close().catch(() => {});
    }
    if (pool) {
      await pool.end().catch(() => {});
    }
    if (stopPgContainer) {
      await stopPgContainer().catch(() => {});
    }
    if (stopNatsContainer) {
      await stopNatsContainer().catch(() => {});
    }
  });

  it('runs complete lifecycle on real PostgreSQL 17 triggers and JetStream projection', async () => {
    if (!app || !pool || !nc) return;

    // 1. Insert active users into auth.users (so auth.public_profiles view exposes them)
    const authorId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
    const videoOwnerId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002';
    const channelId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9003';
    const strangerId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9004';

    await pool.query(`
      INSERT INTO auth.users (id, email, handle, display_name, avatar_key, status)
      VALUES
        ('${authorId}', 'author@winkey.vn', 'alice', 'Alice Author', 'avatars/alice.png', 'ACTIVE'),
        ('${videoOwnerId}', 'owner@winkey.vn', 'bob_owner', 'Bob Creator', NULL, 'ACTIVE'),
        ('${channelId}', 'channel@winkey.vn', 'charlie_channel', 'Charlie TV', 'avatars/charlie.png', 'ACTIVE'),
        ('${strangerId}', 'stranger@winkey.vn', 'david', 'David Stranger', NULL, 'ACTIVE')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Projection Consumer: send video.ready event twice (idempotency)
    const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9010';
    const js = nc.jetstream();

    const videoReadyEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9099',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: videoId,
        owner_id: videoOwnerId,
        job_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9098',
        attempt: 1,
        encoder: 'x264',
        hls_master_key: `hls/${videoId}/master.m3u8`,
        thumbnail_key: `thumbnails/${videoId}.jpg`,
        duration_ms: 120000,
        width: 1920,
        height: 1080,
        renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 4500 }],
      },
    };

    // Send twice
    await js.publish('video.ready', Buffer.from(JSON.stringify(videoReadyEvent)));
    await js.publish('video.ready', Buffer.from(JSON.stringify(videoReadyEvent)));

    // Wait briefly for projection consumer
    let videoRow: any = null;
    for (let i = 0; i < 20; i++) {
      const res = await pool.query('SELECT * FROM social.videos WHERE id = $1', [videoId]);
      if (res.rows.length === 1) {
        videoRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(videoRow).not.toBeNull();
    expect(videoRow.owner_id).toBe(videoOwnerId);
    expect(Number(videoRow.comment_count)).toBe(0);
    expect(Number(videoRow.like_count)).toBe(0);

    // 3. Unknown video returns 404
    const unknownRes = await app.inject({
      method: 'POST',
      url: '/v1/videos/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999/comments',
      headers: { 'x-user-id': authorId },
      payload: { body: 'hello' },
    });
    expect(unknownRes.statusCode).toBe(404);

    // 4. Create top-level comment
    const commentRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId, 'x-user-roles': 'viewer' },
      payload: { body: 'First comment on this awesome video!' },
    });
    expect(commentRes.statusCode).toBe(201);
    const comment = commentRes.json();
    const commentId = comment.id;

    // Check DB triggers updated comment_count on video
    const videoAfterComment = await pool.query(
      'SELECT comment_count FROM social.videos WHERE id = $1',
      [videoId],
    );
    expect(Number(videoAfterComment.rows[0].comment_count)).toBe(1);

    // Check Outbox event social.comment.created
    const commentOutbox = await pool.query(
      `SELECT * FROM social.outbox WHERE subject = 'social.comment.created' AND payload->'data'->>'comment_id' = $1`,
      [commentId],
    );
    expect(commentOutbox.rows).toHaveLength(1);
    const commentPayload = commentOutbox.rows[0].payload;
    expect(validateCommentCreated(commentPayload)).toBe(true);
    expect(commentPayload.data.video_owner_id).toBe(videoOwnerId);
    expect(commentPayload.data.parent_id).toBeNull();
    expect(commentPayload.data.parent_author_id).toBeNull();

    // 5. Create Reply to top-level comment
    const replyRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': strangerId },
      payload: { parent_id: commentId, body: 'I agree with your comment!' },
    });
    expect(replyRes.statusCode).toBe(201);
    const reply = replyRes.json();
    const replyId = reply.id;

    // Trigger check: comment_count on video is now 2; reply_count on parent is 1
    const videoAfterReply = await pool.query(
      'SELECT comment_count FROM social.videos WHERE id = $1',
      [videoId],
    );
    expect(Number(videoAfterReply.rows[0].comment_count)).toBe(2);
    const parentAfterReply = await pool.query(
      'SELECT reply_count FROM social.comments WHERE id = $1',
      [commentId],
    );
    expect(Number(parentAfterReply.rows[0].reply_count)).toBe(1);

    // 6. Two levels rule: Attempting to reply to a reply is rejected with 409
    const nestedRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { parent_id: replyId, body: 'Replying to a reply (nested)' },
    });
    expect(nestedRes.statusCode).toBe(409);
    expect(nestedRes.json().code).toBe('PARENT_NOT_REPLYABLE');

    // 7. Cross-video parent rejected with 409
    const secondVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9020';
    await pool.query('INSERT INTO social.videos (id, owner_id) VALUES ($1, $2)', [
      secondVideoId,
      videoOwnerId,
    ]);

    const crossVideoRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${secondVideoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { parent_id: commentId, body: 'Replying to comment from first video' },
    });
    expect(crossVideoRes.statusCode).toBe(409);
    expect(crossVideoRes.json().code).toBe('PARENT_NOT_REPLYABLE');

    // 8. Permissions: Edit comment
    // Stranger cannot edit author's comment
    const strangerEditRes = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${commentId}`,
      headers: { 'x-user-id': strangerId },
      payload: { body: 'Hacked by stranger' },
    });
    expect(strangerEditRes.statusCode).toBe(403);

    // Author can edit
    const authorEditRes = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${commentId}`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'Edited first comment body' },
    });
    expect(authorEditRes.statusCode).toBe(200);
    expect(authorEditRes.json().body).toBe('Edited first comment body');

    // 9. Hide and Restore: counters follow VISIBLE transitions
    // Non-moderator cannot moderate
    const unauthModRes = await app.inject({
      method: 'PUT',
      url: `/v1/comments/${replyId}/moderation`,
      headers: { 'x-user-id': strangerId, 'x-user-roles': 'viewer' },
      payload: { status: 'HIDDEN' },
    });
    expect(unauthModRes.statusCode).toBe(403);

    // Moderator hides reply
    const modHideRes = await app.inject({
      method: 'PUT',
      url: `/v1/comments/${replyId}/moderation`,
      headers: { 'x-user-id': strangerId, 'x-user-roles': 'moderator' },
      payload: { status: 'HIDDEN' },
    });
    expect(modHideRes.statusCode).toBe(200);

    // Counters: video comment_count decreases to 1, parent reply_count decreases to 0
    const videoAfterHide = await pool.query(
      'SELECT comment_count FROM social.videos WHERE id = $1',
      [videoId],
    );
    expect(Number(videoAfterHide.rows[0].comment_count)).toBe(1);
    const parentAfterHide = await pool.query(
      'SELECT reply_count FROM social.comments WHERE id = $1',
      [commentId],
    );
    expect(Number(parentAfterHide.rows[0].reply_count)).toBe(0);

    // Regular viewer cannot see HIDDEN reply in replies list
    const viewerReplies = await app.inject({
      method: 'GET',
      url: `/v1/comments/${commentId}/replies`,
      headers: { 'x-user-id': authorId },
    });
    expect(viewerReplies.json().items).toHaveLength(0);

    // Moderator CAN see HIDDEN reply
    const modReplies = await app.inject({
      method: 'GET',
      url: `/v1/comments/${commentId}/replies`,
      headers: { 'x-user-id': strangerId, 'x-user-roles': 'moderator' },
    });
    expect(modReplies.json().items).toHaveLength(1);

    // Restore reply to VISIBLE
    await app.inject({
      method: 'PUT',
      url: `/v1/comments/${replyId}/moderation`,
      headers: { 'x-user-id': strangerId, 'x-user-roles': 'admin' },
      payload: { status: 'VISIBLE' },
    });
    const videoAfterRestore = await pool.query(
      'SELECT comment_count FROM social.videos WHERE id = $1',
      [videoId],
    );
    expect(Number(videoAfterRestore.rows[0].comment_count)).toBe(2);

    // 10. Delete comment & Tombstone rules
    // Video owner can delete comment
    const ownerDelRes = await app.inject({
      method: 'DELETE',
      url: `/v1/comments/${commentId}`,
      headers: { 'x-user-id': videoOwnerId },
    });
    expect(ownerDelRes.statusCode).toBe(204);

    // Comment is now DELETED. Because it has replies, it remains as a tombstone
    const tombstoneRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${videoId}/comments`,
    });
    expect(tombstoneRes.json().items).toHaveLength(1);
    const tombstone = tombstoneRes.json().items[0];
    expect(tombstone.status).toBe('DELETED');
    expect(tombstone.body).toBe('');

    // Attempting to moderate a DELETED comment yields 409
    const modDeletedRes = await app.inject({
      method: 'PUT',
      url: `/v1/comments/${commentId}/moderation`,
      headers: { 'x-user-id': strangerId, 'x-user-roles': 'admin' },
      payload: { status: 'VISIBLE' },
    });
    expect(modDeletedRes.statusCode).toBe(409);

    // 11. Likes Idempotency & Events
    // PUT twice -> 1 like row, ONE outbox event
    const like1 = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${videoId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(like1.statusCode).toBe(200);
    expect(like1.json().like_count).toBe(1);

    const like2 = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${videoId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(like2.statusCode).toBe(200);

    const likeEvents = await pool.query(
      `SELECT * FROM social.outbox WHERE subject = 'social.video.like_changed' AND payload->'data'->>'video_id' = $1 AND payload->'data'->>'liked' = 'true'`,
      [videoId],
    );
    expect(likeEvents.rows).toHaveLength(1);
    expect(validateLikeChanged(likeEvents.rows[0].payload)).toBe(true);

    // DELETE unlike twice -> ONE unlike outbox event
    await app.inject({
      method: 'DELETE',
      url: `/v1/videos/${videoId}/like`,
      headers: { 'x-user-id': authorId },
    });
    await app.inject({
      method: 'DELETE',
      url: `/v1/videos/${videoId}/like`,
      headers: { 'x-user-id': authorId },
    });

    const unlikeEvents = await pool.query(
      `SELECT * FROM social.outbox WHERE subject = 'social.video.like_changed' AND payload->'data'->>'video_id' = $1 AND payload->'data'->>'liked' = 'false'`,
      [videoId],
    );
    expect(unlikeEvents.rows).toHaveLength(1);

    // 12. Subscriptions Idempotency & Events
    // Cannot subscribe to self
    const selfSub = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${authorId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(selfSub.statusCode).toBe(400);

    // Subscribe twice -> 1 row, ONE outbox event
    await app.inject({
      method: 'PUT',
      url: `/v1/channels/${channelId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    await app.inject({
      method: 'PUT',
      url: `/v1/channels/${channelId}/subscription`,
      headers: { 'x-user-id': authorId },
    });

    const subEvents = await pool.query(
      `SELECT * FROM social.outbox WHERE subject = 'social.subscription.changed' AND payload->'data'->>'channel_id' = $1 AND payload->'data'->>'subscribed' = 'true'`,
      [channelId],
    );
    expect(subEvents.rows).toHaveLength(1);
    expect(validateSubChanged(subEvents.rows[0].payload)).toBe(true);

    // 13. Keyset Pagination Stability
    // Insert 5 comments
    for (let i = 1; i <= 5; i++) {
      await app.inject({
        method: 'POST',
        url: `/v1/videos/${secondVideoId}/comments`,
        headers: { 'x-user-id': authorId },
        payload: { body: `Pagination test comment ${i}` },
      });
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `/v1/videos/${secondVideoId}/comments?limit=2`,
    });
    expect(page1.statusCode).toBe(200);
    const p1Body = page1.json();
    expect(p1Body.items).toHaveLength(2);
    expect(p1Body.next_cursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/videos/${secondVideoId}/comments?limit=2&cursor=${p1Body.next_cursor}`,
    });
    expect(page2.statusCode).toBe(200);
    const p2Body = page2.json();
    expect(p2Body.items).toHaveLength(2);
    expect(p2Body.next_cursor).not.toBeNull();

    // Verify no duplicates between pages
    const ids1 = p1Body.items.map((i: any) => i.id);
    const ids2 = p2Body.items.map((i: any) => i.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);

    // Regression check: verify all items strictly have video_id === secondVideoId and no other video comments leaked in
    for (const item of [...p1Body.items, ...p2Body.items]) {
      expect(item.video_id).toBe(secondVideoId);
    }

    // 13b. Subscriptions Isolation Regression Test: 2 users, limit=1
    // Author subscribed to channelId in step 12. Stranger subscribes to videoOwnerId.
    await app.inject({
      method: 'PUT',
      url: `/v1/channels/${videoOwnerId}/subscription`,
      headers: { 'x-user-id': strangerId },
    });

    // Author queries /v1/me/subscriptions with limit=1: only sees own subscription (channelId)
    const authorSubsP1 = await app.inject({
      method: 'GET',
      url: '/v1/me/subscriptions?limit=1',
      headers: { 'x-user-id': authorId },
    });
    expect(authorSubsP1.statusCode).toBe(200);
    const authorSubsP1Body = authorSubsP1.json();
    for (const item of authorSubsP1Body.items) {
      expect(item.channel.id).toBe(channelId);
    }

    if (authorSubsP1Body.next_cursor) {
      const authorSubsP2 = await app.inject({
        method: 'GET',
        url: `/v1/me/subscriptions?limit=1&cursor=${encodeURIComponent(authorSubsP1Body.next_cursor)}`,
        headers: { 'x-user-id': authorId },
      });
      expect(authorSubsP2.statusCode).toBe(200);
      const authorSubsP2Body = authorSubsP2.json();
      for (const item of authorSubsP2Body.items) {
        expect(item.channel.id).toBe(channelId);
      }
    }

    // Stranger queries /v1/me/subscriptions with limit=1: only sees own subscription (videoOwnerId)
    const strangerSubsP1 = await app.inject({
      method: 'GET',
      url: '/v1/me/subscriptions?limit=1',
      headers: { 'x-user-id': strangerId },
    });
    expect(strangerSubsP1.statusCode).toBe(200);
    const strangerSubsP1Body = strangerSubsP1.json();
    for (const item of strangerSubsP1Body.items) {
      expect(item.channel.id).toBe(videoOwnerId);
    }

    // 14. Projection Consumer: video.deleted cascades comments and likes
    const videoDeleteEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9088',
      type: 'video.deleted',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'video-svc',
      data: {
        video_id: videoId,
        owner_id: videoOwnerId,
        raw_bucket: 'raw',
        raw_key: 'raw-key',
        media_bucket: 'media',
        media_prefix: `v/${videoId}/`,
      },
    };

    await js.publish('video.deleted', Buffer.from(JSON.stringify(videoDeleteEvent)));

    // Poll until video and its comments are deleted
    let cascadeOk = false;
    for (let i = 0; i < 20; i++) {
      const v = await pool.query('SELECT * FROM social.videos WHERE id = $1', [videoId]);
      const c = await pool.query('SELECT * FROM social.comments WHERE video_id = $1', [videoId]);
      if (v.rows.length === 0 && c.rows.length === 0) {
        cascadeOk = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(cascadeOk).toBe(true);

    // 15. Keyset Microsecond Precision Test (7 comments with identical created_at)
    // Architect review: insert ~7 comments with identical created_at, paginate limit=2, assert all ids retrieved, no duplicates, no gaps. For both top-level and replies.
    const microsecondVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9030';
    await pool.query('INSERT INTO social.videos (id, owner_id) VALUES ($1, $2)', [
      microsecondVideoId,
      videoOwnerId,
    ]);

    // Top-level identical timestamp test
    const fixedTopTimestamp = '2026-09-29 12:34:56.123456+00';
    const topLevelExpectedIds: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const cid = `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b000${i}`;
      topLevelExpectedIds.push(cid);
      await pool.query(
        `INSERT INTO social.comments (id, video_id, author_id, parent_id, body, status, created_at)
         VALUES ($1, $2, $3, NULL, $4, 'VISIBLE', $5::timestamptz)`,
        [cid, microsecondVideoId, authorId, `Identical timestamp top ${i}`, fixedTopTimestamp],
      );
    }

    // Paginate top-level with limit=2
    const retrievedTopIds: string[] = [];
    let topCursor: string | null = null;
    let maxPages = 10;
    while (maxPages-- > 0) {
      const topUrl: string = topCursor
        ? `/v1/videos/${microsecondVideoId}/comments?limit=2&cursor=${encodeURIComponent(topCursor)}`
        : `/v1/videos/${microsecondVideoId}/comments?limit=2`;
      const res = await app.inject({ method: 'GET', url: topUrl });
      expect(res.statusCode).toBe(200);
      const data: any = res.json();
      for (const item of data.items) {
        retrievedTopIds.push(item.id);
      }
      topCursor = data.next_cursor;
      if (!topCursor) break;
    }

    expect(retrievedTopIds).toHaveLength(7);
    expect(new Set(retrievedTopIds).size).toBe(7);
    for (const expectedId of topLevelExpectedIds) {
      expect(retrievedTopIds).toContain(expectedId);
    }

    // Replies identical timestamp test
    const parentCommentId = topLevelExpectedIds[0];
    const fixedReplyTimestamp = '2026-09-29 12:34:56.654321+00';
    const replyExpectedIds: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const rid = `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b001${i}`;
      replyExpectedIds.push(rid);
      await pool.query(
        `INSERT INTO social.comments (id, video_id, author_id, parent_id, body, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'VISIBLE', $6::timestamptz)`,
        [
          rid,
          microsecondVideoId,
          strangerId,
          parentCommentId,
          `Identical timestamp reply ${i}`,
          fixedReplyTimestamp,
        ],
      );
    }

    // Paginate replies with limit=2 (oldest first)
    const retrievedReplyIds: string[] = [];
    let replyCursor: string | null = null;
    maxPages = 10;
    while (maxPages-- > 0) {
      const replyUrl: string = replyCursor
        ? `/v1/comments/${parentCommentId}/replies?limit=2&cursor=${encodeURIComponent(replyCursor)}`
        : `/v1/comments/${parentCommentId}/replies?limit=2`;
      const res = await app.inject({ method: 'GET', url: replyUrl });
      expect(res.statusCode).toBe(200);
      const data: any = res.json();
      for (const item of data.items) {
        retrievedReplyIds.push(item.id);
      }
      replyCursor = data.next_cursor;
      if (!replyCursor) break;
    }

    expect(retrievedReplyIds).toHaveLength(7);
    expect(new Set(retrievedReplyIds).size).toBe(7);
    for (const expectedId of replyExpectedIds) {
      expect(retrievedReplyIds).toContain(expectedId);
    }

    // 16. Invalid UUID and Cursor Handling (avoid Postgres 22P02 500 error)
    const invalidId = 'not-a-valid-uuid';
    // 400 routes
    const c1 = await app.inject({ method: 'GET', url: `/v1/videos/${invalidId}/comments` });
    expect(c1.statusCode).toBe(400);
    expect(c1.json().code).toBe('INVALID_ID');

    const c2 = await app.inject({
      method: 'POST',
      url: `/v1/videos/${invalidId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'hello' },
    });
    expect(c2.statusCode).toBe(400);
    expect(c2.json().code).toBe('INVALID_ID');

    const c3 = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${invalidId}`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'hello' },
    });
    expect(c3.statusCode).toBe(400);
    expect(c3.json().code).toBe('INVALID_ID');

    const c4 = await app.inject({ method: 'GET', url: `/v1/comments/${invalidId}/replies` });
    expect(c4.statusCode).toBe(400);
    expect(c4.json().code).toBe('INVALID_ID');

    const c5 = await app.inject({
      method: 'PUT',
      url: `/v1/comments/${invalidId}/moderation`,
      headers: { 'x-user-id': authorId, 'x-user-roles': 'moderator' },
      payload: { status: 'HIDDEN' },
    });
    expect(c5.statusCode).toBe(400);
    expect(c5.json().code).toBe('INVALID_ID');

    const c6 = await app.inject({ method: 'GET', url: `/v1/channels/${invalidId}/subscription` });
    expect(c6.statusCode).toBe(400);
    expect(c6.json().code).toBe('INVALID_ID');

    const c7 = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${invalidId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(c7.statusCode).toBe(400);
    expect(c7.json().code).toBe('INVALID_ID');

    // 404 routes
    const c8 = await app.inject({ method: 'GET', url: `/v1/comments/${invalidId}` });
    expect(c8.statusCode).toBe(404);

    const c9 = await app.inject({
      method: 'DELETE',
      url: `/v1/comments/${invalidId}`,
      headers: { 'x-user-id': authorId },
    });
    expect(c9.statusCode).toBe(404);

    const c10 = await app.inject({ method: 'GET', url: `/v1/videos/${invalidId}/like` });
    expect(c10.statusCode).toBe(404);

    const c11 = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${invalidId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(c11.statusCode).toBe(404);

    const c12 = await app.inject({
      method: 'DELETE',
      url: `/v1/videos/${invalidId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(c12.statusCode).toBe(404);

    // DELETE subscription returns 200
    const c13 = await app.inject({
      method: 'DELETE',
      url: `/v1/channels/${invalidId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(c13.statusCode).toBe(200);

    // Invalid X-User-Id returns 401
    const c14 = await app.inject({
      method: 'GET',
      url: `/v1/videos/${secondVideoId}/comments`,
      headers: { 'x-user-id': 'bad-uuid' },
    });
    expect(c14.statusCode).toBe(401);

    // Invalid cursor returns 400
    const c15 = await app.inject({
      method: 'GET',
      url: `/v1/videos/${secondVideoId}/comments?cursor=bad_base64_json`,
    });
    expect(c15.statusCode).toBe(400);
    expect(c15.json().code).toBe('INVALID_CURSOR');

    // 17. JetStream Poison Message Handling & Subsequent Success
    // Send malformed JSON
    await js.publish('video.ready', Buffer.from('malformed json {{{'));
    // Send invalid UUID
    await js.publish(
      'video.ready',
      Buffer.from(
        JSON.stringify({
          event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9090',
          type: 'video.ready',
          version: 1,
          data: { video_id: 'not-a-uuid', owner_id: 'not-a-uuid' },
        }),
      ),
    );

    // Send valid video.ready for a new video
    const poisonRecoverVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9040';
    const validVideoEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9091',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: poisonRecoverVideoId,
        owner_id: videoOwnerId,
        job_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9092',
        attempt: 1,
        encoder: 'x264',
        hls_master_key: `hls/${poisonRecoverVideoId}/master.m3u8`,
        thumbnail_key: `thumbnails/${poisonRecoverVideoId}.jpg`,
        duration_ms: 60000,
        width: 1920,
        height: 1080,
        renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 4500 }],
      },
    };
    await js.publish('video.ready', Buffer.from(JSON.stringify(validVideoEvent)));

    let recoveredVideo = false;
    for (let i = 0; i < 20; i++) {
      const v = await pool.query('SELECT * FROM social.videos WHERE id = $1', [
        poisonRecoverVideoId,
      ]);
      if (v.rows.length === 1) {
        recoveredVideo = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(recoveredVideo).toBe(true);

    // 18. Race Conditions & Deleted Video Handling
    // Deleted video race on comment creation returns 404
    const nonExistentVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9050';
    const deletedVideoCommentRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${nonExistentVideoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'Comment on non-existent video' },
    });
    expect(deletedVideoCommentRes.statusCode).toBe(404);
    expect(deletedVideoCommentRes.json().code).toBe('VIDEO_NOT_FOUND');

    // Deleted video race on like returns 404
    const deletedVideoLikeRes = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${nonExistentVideoId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(deletedVideoLikeRes.statusCode).toBe(404);
    expect(deletedVideoLikeRes.json().code).toBe('VIDEO_NOT_FOUND');

    // 19. Task A2: Video Moderation Projection & Moderation Workflow
    const modVideoId = poisonRecoverVideoId;
    const moderatorId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999';
    const modHeaders = { 'x-user-id': moderatorId, 'x-user-roles': 'moderator' };

    // Publish video.moderated with state: 'HIDDEN'
    const hideEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9993',
      type: 'video.moderated',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'video',
      data: {
        video_id: modVideoId,
        owner_id: videoOwnerId,
        state: 'HIDDEN',
        moderator_id: moderatorId,
      },
    };
    await js.publish('video.moderated', Buffer.from(JSON.stringify(hideEvent)));

    // Wait for projection to update social.videos hidden = true
    let isHidden = false;
    for (let i = 0; i < 20; i++) {
      const v = await pool.query('SELECT hidden FROM social.videos WHERE id = $1', [modVideoId]);
      if (v.rows.length === 1 && v.rows[0].hidden === true) {
        isHidden = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(isHidden).toBe(true);

    // Hidden video returns 404 for viewer
    const viewerCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${modVideoId}/comments`,
      headers: { 'x-user-id': authorId, 'x-user-roles': 'viewer' },
    });
    expect(viewerCommentsRes.statusCode).toBe(404);

    const viewerLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${modVideoId}/like`,
      headers: { 'x-user-id': authorId, 'x-user-roles': 'viewer' },
    });
    expect(viewerLikeRes.statusCode).toBe(404);

    // Hidden video allows moderator access
    const modCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${modVideoId}/comments`,
      headers: modHeaders,
    });
    expect(modCommentsRes.statusCode).toBe(200);

    const modLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${modVideoId}/like`,
      headers: modHeaders,
    });
    expect(modLikeRes.statusCode).toBe(200);

    // Create report on hidden video by moderator
    const rep1Res = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: modHeaders,
      payload: {
        target_type: 'VIDEO',
        target_id: modVideoId,
        reason: 'SPAM',
        note: 'Flagged for moderation',
      },
    });
    expect(rep1Res.statusCode).toBe(201);
    const rep1 = rep1Res.json();
    expect(rep1.id).toBeDefined();

    // Deduplication check: second report while OPEN returns 200 with same id
    const rep2Res = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: modHeaders,
      payload: {
        target_type: 'VIDEO',
        target_id: modVideoId,
        reason: 'SPAM',
      },
    });
    expect(rep2Res.statusCode).toBe(200);
    expect(rep2Res.json().id).toBe(rep1.id);

    // Moderation queue: list cases
    const queueRes = await app.inject({
      method: 'GET',
      url: '/v1/moderation/reports',
      headers: modHeaders,
    });
    expect(queueRes.statusCode).toBe(200);
    const queueData = queueRes.json();
    expect(queueData.items.length).toBeGreaterThanOrEqual(1);

    // Resolve case
    const resolveRes = await app.inject({
      method: 'PUT',
      url: `/v1/moderation/cases/VIDEO/${modVideoId}/resolution`,
      headers: modHeaders,
      payload: { status: 'ACTIONED', note: 'Case actioned' },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().resolved_count).toBeGreaterThanOrEqual(1);

    // Restore video: state: 'VISIBLE'
    const restoreEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9994',
      type: 'video.moderated',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'video',
      data: {
        video_id: modVideoId,
        owner_id: videoOwnerId,
        state: 'VISIBLE',
        moderator_id: moderatorId,
      },
    };
    await js.publish('video.moderated', Buffer.from(JSON.stringify(restoreEvent)));

    // Wait for projection to update social.videos hidden = false
    let isVisible = false;
    for (let i = 0; i < 20; i++) {
      const v = await pool.query('SELECT hidden FROM social.videos WHERE id = $1', [modVideoId]);
      if (v.rows.length === 1 && v.rows[0].hidden === false) {
        isVisible = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(isVisible).toBe(true);

    // Viewer can access restored video comments and likes again
    const restoredCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${modVideoId}/comments`,
      headers: { 'x-user-id': authorId, 'x-user-roles': 'viewer' },
    });
    expect(restoredCommentsRes.statusCode).toBe(200);
  });
});
