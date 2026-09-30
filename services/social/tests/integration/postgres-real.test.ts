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
import { parse as parseYaml } from 'yaml';
import { v7 as uuidv7 } from 'uuid';
import {
  NotificationsJanitor,
  NOTIFICATIONS_JANITOR_LOCK_KEY,
} from '../../src/janitor/notifications-janitor.js';
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
  let validateNotification: any;
  let validateNotificationPage: any;
  let validateUnreadCount: any;
  let validateProblem: any;

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

    // OpenAPI contracts
    const openapiDir = path.join(repoRoot, 'contracts', 'openapi');
    const socialSpec = parseYaml(fs.readFileSync(path.join(openapiDir, 'social.v1.yaml'), 'utf8'));
    const commonSpec = parseYaml(fs.readFileSync(path.join(openapiDir, 'common.yaml'), 'utf8'));
    commonSpec.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
    socialSpec.$id = 'https://winkey.vn/contracts/openapi/social.v1.yaml';
    ajv.addSchema(commonSpec);
    ajv.addSchema(socialSpec);
    validateNotification = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/Notification',
    )!;
    validateNotificationPage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/NotificationPage',
    )!;
    validateUnreadCount = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/UnreadCount',
    )!;
    validateProblem = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/Problem',
    )!;

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

    // Hidden video returns 404 for video owner as well (only moderator and admin can access hidden videos)
    const ownerHiddenRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${modVideoId}/comments`,
      headers: { 'x-user-id': videoOwnerId, 'x-user-roles': 'creator' },
    });
    expect(ownerHiddenRes.statusCode).toBe(404);

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

  it('verifies video visibility projection and unified access control (Task C4-a)', async () => {
    if (!app || !pool || !nc) return;

    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();

    // 1. Verify consumer configuration: existing durable social-videos updated with all 4 filter_subjects
    const consumerInfo = await jsm.consumers.info('VIDEO', 'social-videos');
    expect(consumerInfo.config.filter_subjects).toBeDefined();
    expect(consumerInfo.config.filter_subjects).toEqual(
      expect.arrayContaining([
        'video.ready',
        'video.deleted',
        'video.moderated',
        'video.visibility_changed',
      ]),
    );
    expect(consumerInfo.config.filter_subjects?.length).toBe(4);

    // Verify consumer is not duplicated
    const consumers = await jsm.consumers.list('VIDEO').next();
    const socialVideoConsumers = consumers.filter((c) => c.name === 'social-videos');
    expect(socialVideoConsumers.length).toBe(1);

    const videoOwnerId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002';
    const outsiderId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bc497';
    const moderatorId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999';
    const adminId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9998';

    await pool.query(`
      INSERT INTO auth.users (id, email, handle, display_name, status)
      VALUES ('${outsiderId}', 'outsider@winkey.vn', 'outsider_c4', 'Outsider User', 'ACTIVE')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Publish video.ready WITHOUT visibility -> defaults to PUBLIC
    const defaultVisVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bc401';
    const videoReadyWithoutVisEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be401',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: defaultVisVideoId,
        owner_id: videoOwnerId,
        job_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be402',
        attempt: 1,
        encoder: 'x264',
        hls_master_key: `hls/${defaultVisVideoId}/master.m3u8`,
        thumbnail_key: `thumbnails/${defaultVisVideoId}.jpg`,
        duration_ms: 60000,
        width: 1280,
        height: 720,
        renditions: [{ name: '720p', width: 1280, height: 720, bitrate_kbps: 2500 }],
      },
    };
    await js.publish('video.ready', Buffer.from(JSON.stringify(videoReadyWithoutVisEvent)));

    let defaultVisRow: pg.QueryResultRow | null = null;
    for (let i = 0; i < 20; i++) {
      const res = await pool.query('SELECT * FROM social.videos WHERE id = $1', [
        defaultVisVideoId,
      ]);
      if (res.rows.length === 1) {
        defaultVisRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(defaultVisRow).not.toBeNull();
    expect(defaultVisRow?.visibility).toBe('PUBLIC');
    expect(defaultVisRow?.hidden).toBe(false);

    // Outsider can view comments on public video
    const pubCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${defaultVisVideoId}/comments`,
    });
    expect(pubCommentsRes.statusCode).toBe(200);

    // 3. Publish video.ready with visibility = PRIVATE -> outsiders 404, owner / moderator / admin 200
    const privateVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bc402';
    const privateVideoReadyEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be403',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: privateVideoId,
        owner_id: videoOwnerId,
        job_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be404',
        attempt: 1,
        encoder: 'x264',
        hls_master_key: `hls/${privateVideoId}/master.m3u8`,
        thumbnail_key: `thumbnails/${privateVideoId}.jpg`,
        duration_ms: 60000,
        width: 1280,
        height: 720,
        renditions: [{ name: '720p', width: 1280, height: 720, bitrate_kbps: 2500 }],
        visibility: 'PRIVATE',
      },
    };
    await js.publish('video.ready', Buffer.from(JSON.stringify(privateVideoReadyEvent)));

    let privateRow: pg.QueryResultRow | null = null;
    for (let i = 0; i < 20; i++) {
      const res = await pool.query('SELECT * FROM social.videos WHERE id = $1', [privateVideoId]);
      if (res.rows.length === 1) {
        privateRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(privateRow).not.toBeNull();
    expect(privateRow?.visibility).toBe('PRIVATE');

    // Outsider (anonymous) gets 404
    const anonCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/comments`,
    });
    expect(anonCommentsRes.statusCode).toBe(404);
    expect(anonCommentsRes.json().code).toBe('VIDEO_NOT_FOUND');

    // Outsider (authenticated viewer) gets 404
    const viewerCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/comments`,
      headers: { 'x-user-id': outsiderId, 'x-user-roles': 'viewer' },
    });
    expect(viewerCommentsRes.statusCode).toBe(404);
    expect(viewerCommentsRes.json().code).toBe('VIDEO_NOT_FOUND');

    // Outsider comment creation returns 404
    const viewerPostCommentRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${privateVideoId}/comments`,
      headers: { 'x-user-id': outsiderId, 'x-user-roles': 'viewer' },
      payload: { body: 'Unauthorized comment' },
    });
    expect(viewerPostCommentRes.statusCode).toBe(404);
    expect(viewerPostCommentRes.json().code).toBe('VIDEO_NOT_FOUND');

    // Outsider like endpoints return 404
    const viewerGetLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/like`,
      headers: { 'x-user-id': outsiderId, 'x-user-roles': 'viewer' },
    });
    expect(viewerGetLikeRes.statusCode).toBe(404);
    expect(viewerGetLikeRes.json().code).toBe('VIDEO_NOT_FOUND');

    const viewerPutLikeRes = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${privateVideoId}/like`,
      headers: { 'x-user-id': outsiderId, 'x-user-roles': 'viewer' },
    });
    expect(viewerPutLikeRes.statusCode).toBe(404);
    expect(viewerPutLikeRes.json().code).toBe('VIDEO_NOT_FOUND');

    // Owner gets 200
    const ownerCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/comments`,
      headers: { 'x-user-id': videoOwnerId, 'x-user-roles': 'creator' },
    });
    expect(ownerCommentsRes.statusCode).toBe(200);

    const ownerPostCommentRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${privateVideoId}/comments`,
      headers: { 'x-user-id': videoOwnerId, 'x-user-roles': 'creator' },
      payload: { body: 'Owner comment on private video' },
    });
    expect(ownerPostCommentRes.statusCode).toBe(201);

    // Owner like gets 200
    const ownerGetLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/like`,
      headers: { 'x-user-id': videoOwnerId, 'x-user-roles': 'creator' },
    });
    expect(ownerGetLikeRes.statusCode).toBe(200);

    // Moderator gets 200
    const modCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/comments`,
      headers: { 'x-user-id': moderatorId, 'x-user-roles': 'moderator' },
    });
    expect(modCommentsRes.statusCode).toBe(200);

    // Admin gets 200
    const adminCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/comments`,
      headers: { 'x-user-id': adminId, 'x-user-roles': 'admin' },
    });
    expect(adminCommentsRes.statusCode).toBe(200);

    // 4. Publish video.visibility_changed PRIVATE -> PUBLIC: reopens video
    const visChangedEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be405',
      type: 'video.visibility_changed',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'video',
      data: {
        video_id: privateVideoId,
        owner_id: videoOwnerId,
        visibility: 'PUBLIC',
      },
    };
    await js.publish('video.visibility_changed', Buffer.from(JSON.stringify(visChangedEvent)));

    let isReopened = false;
    for (let i = 0; i < 20; i++) {
      const res = await pool.query('SELECT visibility FROM social.videos WHERE id = $1', [
        privateVideoId,
      ]);
      if (res.rows.length === 1 && res.rows[0].visibility === 'PUBLIC') {
        isReopened = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(isReopened).toBe(true);

    // Outsider can now access comments and like
    const reopenedCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/comments`,
      headers: { 'x-user-id': outsiderId, 'x-user-roles': 'viewer' },
    });
    expect(reopenedCommentsRes.statusCode).toBe(200);

    const reopenedLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privateVideoId}/like`,
      headers: { 'x-user-id': outsiderId, 'x-user-roles': 'viewer' },
    });
    expect(reopenedLikeRes.statusCode).toBe(200);

    // 5. Publish video.visibility_changed for unknown video ID is acked and skipped
    const unknownVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bc499';
    const unknownVisEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be406',
      type: 'video.visibility_changed',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'video',
      data: {
        video_id: unknownVideoId,
        owner_id: videoOwnerId,
        visibility: 'UNLISTED',
      },
    };
    await js.publish('video.visibility_changed', Buffer.from(JSON.stringify(unknownVisEvent)));

    // Verify consumer continues to process subsequent messages normally (UNLISTED video = PUBLIC behavior)
    const unlistedVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bc403';
    const unlistedReadyEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be407',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: unlistedVideoId,
        owner_id: videoOwnerId,
        job_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be408',
        attempt: 1,
        encoder: 'x264',
        hls_master_key: `hls/${unlistedVideoId}/master.m3u8`,
        thumbnail_key: `thumbnails/${unlistedVideoId}.jpg`,
        duration_ms: 10000,
        width: 1280,
        height: 720,
        renditions: [{ name: '720p', width: 1280, height: 720, bitrate_kbps: 2500 }],
        visibility: 'UNLISTED',
      },
    };
    await js.publish('video.ready', Buffer.from(JSON.stringify(unlistedReadyEvent)));

    let unlistedRow: pg.QueryResultRow | null = null;
    for (let i = 0; i < 20; i++) {
      const res = await pool.query('SELECT * FROM social.videos WHERE id = $1', [unlistedVideoId]);
      if (res.rows.length === 1) {
        unlistedRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(unlistedRow).not.toBeNull();
    expect(unlistedRow?.visibility).toBe('UNLISTED');

    // UNLISTED is open to outsiders
    const unlistedCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${unlistedVideoId}/comments`,
      headers: { 'x-user-id': outsiderId, 'x-user-roles': 'viewer' },
    });
    expect(unlistedCommentsRes.statusCode).toBe(200);
  });

  it('runs full in-app notifications lifecycle on real PostgreSQL 17 + NATS JetStream (Task N1)', async () => {
    if (!app || !pool || !nc) return;

    const js = nc.jetstream();

    // 1. Setup Users in auth.users and channels in social.channels
    const n1Owner = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd001';
    const n1UserA = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd002';
    const n1UserB = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd003';
    const n1UserC = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd004';
    const n1Suspended = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd005';

    await pool.query(`
        INSERT INTO auth.users (id, email, handle, display_name, avatar_key, status)
        VALUES
          ('${n1Owner}', 'n1_owner@winkey.vn', 'n1_owner', 'Owner Channel', NULL, 'ACTIVE'),
          ('${n1UserA}', 'n1_usera@winkey.vn', 'n1_usera', 'User Alice', 'avatars/alice.png', 'ACTIVE'),
          ('${n1UserB}', 'n1_userb@winkey.vn', 'n1_userb', 'User Bob', NULL, 'ACTIVE'),
          ('${n1UserC}', 'n1_userc@winkey.vn', 'n1_userc', 'User Carol', NULL, 'ACTIVE'),
          ('${n1Suspended}', 'n1_suspended@winkey.vn', 'n1_suspended', 'Suspended User', NULL, 'SUSPENDED')
        ON CONFLICT (id) DO NOTHING;
      `);

    await pool.query(`
        INSERT INTO social.channels (id, subscriber_count)
        VALUES
          ('${n1Owner}', 0),
          ('${n1UserA}', 0),
          ('${n1UserB}', 0),
          ('${n1UserC}', 0)
        ON CONFLICT (id) DO NOTHING;
      `);

    // Video setup
    const n1Video1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd010';
    await pool.query(`
        INSERT INTO social.videos (id, owner_id, visibility, hidden, like_count, comment_count)
        VALUES ('${n1Video1}', '${n1Owner}', 'PUBLIC', false, 0, 0)
        ON CONFLICT (id) DO NOTHING;
      `);

    // 2. Comments and Subscriptions notifications
    // 2a. comment -> owner notified, own comment produces nothing
    const commentRes1 = await app.inject({
      method: 'POST',
      url: `/v1/videos/${n1Video1}/comments`,
      headers: { 'x-user-id': n1UserA },
      payload: { body: 'Top level comment by Alice' },
    });
    expect(commentRes1.statusCode).toBe(201);
    const comment1 = commentRes1.json();

    const notifQuery1 = await pool.query(
      'SELECT * FROM social.notifications WHERE user_id = $1 AND kind = $2',
      [n1Owner, 'VIDEO_COMMENT'],
    );
    expect(notifQuery1.rows.length).toBe(1);
    expect(notifQuery1.rows[0].actor_id).toBe(n1UserA);
    expect(notifQuery1.rows[0].video_id).toBe(n1Video1);
    expect(notifQuery1.rows[0].comment_id).toBe(comment1.id);

    // Own comment by owner produces nothing
    const ownCommentRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${n1Video1}/comments`,
      headers: { 'x-user-id': n1Owner },
      payload: { body: 'Owner comment on own video' },
    });
    expect(ownCommentRes.statusCode).toBe(201);

    const notifQueryOwnerSelf = await pool.query(
      'SELECT * FROM social.notifications WHERE user_id = $1 AND actor_id = $1',
      [n1Owner],
    );
    expect(notifQueryOwnerSelf.rows.length).toBe(0);

    // 2b. reply -> parent author notified (not the owner), own reply produces nothing
    const replyRes1 = await app.inject({
      method: 'POST',
      url: `/v1/videos/${n1Video1}/comments`,
      headers: { 'x-user-id': n1UserB },
      payload: { parent_id: comment1.id, body: 'Reply by Bob to Alice' },
    });
    expect(replyRes1.statusCode).toBe(201);
    const reply1 = replyRes1.json();

    const notifReplyToAlice = await pool.query(
      'SELECT * FROM social.notifications WHERE user_id = $1 AND kind = $2',
      [n1UserA, 'COMMENT_REPLY'],
    );
    expect(notifReplyToAlice.rows.length).toBe(1);
    expect(notifReplyToAlice.rows[0].actor_id).toBe(n1UserB);
    expect(notifReplyToAlice.rows[0].comment_id).toBe(reply1.id);

    // Video owner should NOT receive a reply notification
    const ownerReplyCount = await pool.query(
      'SELECT * FROM social.notifications WHERE user_id = $1 AND kind = $2',
      [n1Owner, 'COMMENT_REPLY'],
    );
    expect(ownerReplyCount.rows.length).toBe(0);

    // Own reply produces nothing
    const ownReplyRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${n1Video1}/comments`,
      headers: { 'x-user-id': n1UserA },
      payload: { parent_id: comment1.id, body: 'Alice replying to herself' },
    });
    expect(ownReplyRes.statusCode).toBe(201);

    // Self subscribe produces nothing
    const selfSubRes = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${n1UserA}/subscription`,
      headers: { 'x-user-id': n1UserA },
    });
    expect(selfSubRes.statusCode).toBe(400);

    // 2c. subscribe twice / unsubscribe + subscribe -> 1 NEW_SUBSCRIBER
    const subRes1 = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${n1Owner}/subscription`,
      headers: { 'x-user-id': n1UserA },
    });
    expect(subRes1.statusCode).toBe(200);

    const subNotif1 = await pool.query(
      'SELECT * FROM social.notifications WHERE user_id = $1 AND kind = $2 AND actor_id = $3',
      [n1Owner, 'NEW_SUBSCRIBER', n1UserA],
    );
    expect(subNotif1.rows.length).toBe(1);

    // Subscribe twice
    const subRes2 = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${n1Owner}/subscription`,
      headers: { 'x-user-id': n1UserA },
    });
    expect(subRes2.statusCode).toBe(200);

    const subNotif2 = await pool.query(
      'SELECT * FROM social.notifications WHERE user_id = $1 AND kind = $2 AND actor_id = $3',
      [n1Owner, 'NEW_SUBSCRIBER', n1UserA],
    );
    expect(subNotif2.rows.length).toBe(1);

    // Unsubscribe
    const unsubRes = await app.inject({
      method: 'DELETE',
      url: `/v1/channels/${n1Owner}/subscription`,
      headers: { 'x-user-id': n1UserA },
    });
    expect(unsubRes.statusCode).toBe(204);

    // Unsubscribe deletes nothing
    const subNotifAfterUnsub = await pool.query(
      'SELECT * FROM social.notifications WHERE user_id = $1 AND kind = $2 AND actor_id = $3',
      [n1Owner, 'NEW_SUBSCRIBER', n1UserA],
    );
    expect(subNotifAfterUnsub.rows.length).toBe(1);

    // Subscribe again -> still 1
    const subRes3 = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${n1Owner}/subscription`,
      headers: { 'x-user-id': n1UserA },
    });
    expect(subRes3.statusCode).toBe(200);

    const subNotif3 = await pool.query(
      'SELECT * FROM social.notifications WHERE user_id = $1 AND kind = $2 AND actor_id = $3',
      [n1Owner, 'NEW_SUBSCRIBER', n1UserA],
    );
    expect(subNotif3.rows.length).toBe(1);

    // 3. Projection Consumer Video Publication Fanout
    // Setup channel with 3 subscribers
    const fanoutChannel = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd050';
    const subUser1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd051';
    const subUser2 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd052';
    const subUser3 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd053';

    await pool.query(`
        INSERT INTO auth.users (id, email, handle, display_name, status)
        VALUES
          ('${fanoutChannel}', 'fanout_ch@winkey.vn', 'fanout_ch', 'Fanout Channel', 'ACTIVE'),
          ('${subUser1}', 'sub1@winkey.vn', 'sub1', 'Sub One', 'ACTIVE'),
          ('${subUser2}', 'sub2@winkey.vn', 'sub2', 'Sub Two', 'ACTIVE'),
          ('${subUser3}', 'sub3@winkey.vn', 'sub3', 'Sub Three', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
      `);

    await pool.query(`
        INSERT INTO social.channels (id, subscriber_count)
        VALUES ('${fanoutChannel}', 3)
        ON CONFLICT (id) DO NOTHING;
      `);

    await pool.query(`
        INSERT INTO social.subscriptions (subscriber_id, channel_id)
        VALUES
          ('${subUser1}', '${fanoutChannel}'),
          ('${subUser2}', '${fanoutChannel}'),
          ('${subUser3}', '${fanoutChannel}')
        ON CONFLICT DO NOTHING;
      `);

    // 3a. video.ready PUBLIC with 3 subscribers -> 3 rows, redelivered -> still 3
    const fanoutVid1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd061';
    const videoReadyPublicEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be501',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: fanoutVid1,
        owner_id: fanoutChannel,
        visibility: 'PUBLIC',
      },
    };

    await js.publish('video.ready', Buffer.from(JSON.stringify(videoReadyPublicEvent)));

    // Poll until 3 rows appear in social.notifications
    let rows3Count = 0;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query(
        'SELECT count(*)::int as count FROM social.notifications WHERE video_id = $1 AND kind = $2',
        [fanoutVid1, 'VIDEO_PUBLISHED'],
      );
      rows3Count = Number(res.rows[0].count);
      if (rows3Count === 3) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(rows3Count).toBe(3);

    // Redeliver same event -> still 3
    await js.publish('video.ready', Buffer.from(JSON.stringify(videoReadyPublicEvent)));
    await new Promise((r) => setTimeout(r, 1000));
    const resRedeliver = await pool.query(
      'SELECT count(*)::int as count FROM social.notifications WHERE video_id = $1 AND kind = $2',
      [fanoutVid1, 'VIDEO_PUBLISHED'],
    );
    expect(Number(resRedeliver.rows[0].count)).toBe(3);

    // 3b. PRIVATE -> nothing, then visibility_changed PUBLIC -> 3, PRIVATE -> PUBLIC again -> still 3
    const fanoutVid2 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd062';
    const videoReadyPrivateEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be502',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: fanoutVid2,
        owner_id: fanoutChannel,
        visibility: 'PRIVATE',
      },
    };

    await js.publish('video.ready', Buffer.from(JSON.stringify(videoReadyPrivateEvent)));
    // Wait for projection
    for (let i = 0; i < 20; i++) {
      const res = await pool.query('SELECT * FROM social.videos WHERE id = $1', [fanoutVid2]);
      if (res.rows.length === 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // PRIVATE -> 0 notifications
    const resPrivCount = await pool.query(
      'SELECT count(*)::int as count FROM social.notifications WHERE video_id = $1',
      [fanoutVid2],
    );
    expect(Number(resPrivCount.rows[0].count)).toBe(0);

    // visibility_changed PUBLIC -> 3 notifications
    const visChangedPublicEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be503',
      type: 'video.visibility_changed',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'video',
      data: {
        video_id: fanoutVid2,
        owner_id: fanoutChannel,
        visibility: 'PUBLIC',
      },
    };

    await js.publish(
      'video.visibility_changed',
      Buffer.from(JSON.stringify(visChangedPublicEvent)),
    );
    for (let i = 0; i < 30; i++) {
      const res = await pool.query(
        'SELECT count(*)::int as count FROM social.notifications WHERE video_id = $1',
        [fanoutVid2],
      );
      if (Number(res.rows[0].count) === 3) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const resPubCount = await pool.query(
      'SELECT count(*)::int as count FROM social.notifications WHERE video_id = $1',
      [fanoutVid2],
    );
    expect(Number(resPubCount.rows[0].count)).toBe(3);

    // PRIVATE -> PUBLIC again -> still 3
    const visChangedPrivateEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be504',
      type: 'video.visibility_changed',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'video',
      data: {
        video_id: fanoutVid2,
        owner_id: fanoutChannel,
        visibility: 'PRIVATE',
      },
    };
    await js.publish(
      'video.visibility_changed',
      Buffer.from(JSON.stringify(visChangedPrivateEvent)),
    );
    await new Promise((r) => setTimeout(r, 500));

    const visChangedPublicEvent2 = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be505',
      type: 'video.visibility_changed',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'video',
      data: {
        video_id: fanoutVid2,
        owner_id: fanoutChannel,
        visibility: 'PUBLIC',
      },
    };
    await js.publish(
      'video.visibility_changed',
      Buffer.from(JSON.stringify(visChangedPublicEvent2)),
    );
    await new Promise((r) => setTimeout(r, 1000));

    const resPubAgainCount = await pool.query(
      'SELECT count(*)::int as count FROM social.notifications WHERE video_id = $1',
      [fanoutVid2],
    );
    expect(Number(resPubAgainCount.rows[0].count)).toBe(3);

    // 3c. UNLISTED -> nothing
    const fanoutVid3 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd063';
    const videoReadyUnlistedEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be506',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: fanoutVid3,
        owner_id: fanoutChannel,
        visibility: 'UNLISTED',
      },
    };
    await js.publish('video.ready', Buffer.from(JSON.stringify(videoReadyUnlistedEvent)));
    for (let i = 0; i < 20; i++) {
      const res = await pool.query('SELECT * FROM social.videos WHERE id = $1', [fanoutVid3]);
      if (res.rows.length === 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const resUnlistedCount = await pool.query(
      'SELECT count(*)::int as count FROM social.notifications WHERE video_id = $1',
      [fanoutVid3],
    );
    expect(Number(resUnlistedCount.rows[0].count)).toBe(0);

    // 3d. 2 500 subscribers -> 2 500 rows (paging keyset)
    const bigChannelId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd100';
    await pool.query(`
        INSERT INTO auth.users (id, email, handle, display_name, status)
        VALUES ('${bigChannelId}', 'big_channel@winkey.vn', 'big_channel', 'Big Star', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
        INSERT INTO social.channels (id, subscriber_count)
        VALUES ('${bigChannelId}', 2500)
        ON CONFLICT (id) DO NOTHING;
      `);

    const bigSubIds: string[] = [];
    const bigSubValues: string[] = [];
    for (let i = 0; i < 2500; i++) {
      const subId = `0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b${String(i).padStart(4, '0')}`;
      bigSubIds.push(subId);
      bigSubValues.push(`('${subId}', 'big_sub_${i}@winkey.vn', 'sub_${i}', 'Sub ${i}', 'ACTIVE')`);
    }

    // Chunk bulk insert users (1000 per chunk)
    for (let i = 0; i < bigSubValues.length; i += 1000) {
      const chunk = bigSubValues.slice(i, i + 1000).join(',');
      await pool.query(`
          INSERT INTO auth.users (id, email, handle, display_name, status)
          VALUES ${chunk}
          ON CONFLICT (id) DO NOTHING;
        `);
    }

    // Bulk insert subscriptions
    const subInsertRows: string[] = bigSubIds.map((id) => `('${id}', '${bigChannelId}')`);
    for (let i = 0; i < subInsertRows.length; i += 1000) {
      const chunk = subInsertRows.slice(i, i + 1000).join(',');
      await pool.query(`
          INSERT INTO social.subscriptions (subscriber_id, channel_id)
          VALUES ${chunk}
          ON CONFLICT DO NOTHING;
        `);
    }

    const bigVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd101';
    const bigVideoReadyEvent = {
      event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be507',
      type: 'video.ready',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'transcoder',
      data: {
        video_id: bigVideoId,
        owner_id: bigChannelId,
        visibility: 'PUBLIC',
      },
    };
    await js.publish('video.ready', Buffer.from(JSON.stringify(bigVideoReadyEvent)));

    let bigNotifCount = 0;
    for (let i = 0; i < 60; i++) {
      const res = await pool.query(
        'SELECT count(*)::int as count FROM social.notifications WHERE video_id = $1',
        [bigVideoId],
      );
      bigNotifCount = Number(res.rows[0].count);
      if (bigNotifCount === 2500) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(bigNotifCount).toBe(2500);

    // 4. List filters: hidden video, PRIVATE video, HIDDEN/DELETED comment, suspended actor with page still full
    const filterRecipient = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd200';
    await pool.query(`
        INSERT INTO auth.users (id, email, handle, display_name, status)
        VALUES ('${filterRecipient}', 'filter_rcp@winkey.vn', 'filter_rcp', 'Filter Recipient', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
      `);

    const privVid = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd201';
    const hiddenVid = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd202';
    const okVid = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd203';
    await pool.query(`
        INSERT INTO social.videos (id, owner_id, visibility, hidden, like_count, comment_count)
        VALUES
          ('${privVid}', '${n1Owner}', 'PRIVATE', false, 0, 0),
          ('${hiddenVid}', '${n1Owner}', 'PUBLIC', true, 0, 0),
          ('${okVid}', '${n1Owner}', 'PUBLIC', false, 0, 0)
        ON CONFLICT (id) DO NOTHING;
      `);

    const hiddenComment = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd204';
    const deletedComment = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd205';
    const okComment = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd206';
    await pool.query(`
        INSERT INTO social.comments (id, video_id, author_id, parent_id, body, status, reply_count)
        VALUES
          ('${hiddenComment}', '${okVid}', '${n1UserA}', NULL, 'Hidden comment', 'HIDDEN', 0),
          ('${deletedComment}', '${okVid}', '${n1UserA}', NULL, '', 'DELETED', 0),
          ('${okComment}', '${okVid}', '${n1UserA}', NULL, 'Ok comment', 'VISIBLE', 0)
        ON CONFLICT (id) DO NOTHING;
      `);

    // Insert 5 filtered notifications
    await pool.query(`
        INSERT INTO social.notifications (id, user_id, actor_id, kind, video_id, comment_id, created_at)
        VALUES
          ('${uuidv7()}', '${filterRecipient}', '${n1UserA}', 'VIDEO_PUBLISHED', '${privVid}', NULL, now()),
          ('${uuidv7()}', '${filterRecipient}', '${n1UserA}', 'VIDEO_PUBLISHED', '${hiddenVid}', NULL, now()),
          ('${uuidv7()}', '${filterRecipient}', '${n1UserA}', 'VIDEO_COMMENT', '${okVid}', '${hiddenComment}', now()),
          ('${uuidv7()}', '${filterRecipient}', '${n1UserA}', 'VIDEO_COMMENT', '${okVid}', '${deletedComment}', now()),
          ('${uuidv7()}', '${filterRecipient}', '${n1Suspended}', 'NEW_SUBSCRIBER', NULL, NULL, now())
        ON CONFLICT DO NOTHING;
      `);

    // Insert 10 valid notifications
    for (let i = 0; i < 10; i++) {
      await pool.query(`
          INSERT INTO social.notifications (id, user_id, actor_id, kind, video_id, comment_id, created_at)
          VALUES ('${uuidv7()}', '${filterRecipient}', '${n1UserA}', 'NEW_SUBSCRIBER', NULL, NULL, now() - interval '${i + 1} minutes')
          ON CONFLICT DO NOTHING;
        `);
    }

    // Fetch limit=10 -> page is still full of 10 items
    const filterRes = await app.inject({
      method: 'GET',
      url: '/v1/notifications?limit=10',
      headers: { 'x-user-id': filterRecipient },
    });
    expect(filterRes.statusCode).toBe(200);
    const filterBody = filterRes.json();
    expect(validateNotificationPage(filterBody)).toBe(true);
    expect(filterBody.items.length).toBe(10);
    // Ensure none of the filtered ones are in the list
    for (const item of filterBody.items) {
      expect(validateNotification(item)).toBe(true);
      expect(item.video_id).not.toBe(privVid);
      expect(item.video_id).not.toBe(hiddenVid);
      expect(item.comment_id).not.toBe(hiddenComment);
      expect(item.comment_id).not.toBe(deletedComment);
      expect(item.actor.id).not.toBe(n1Suspended);
    }

    // 5. Cursor walk over 45 rows with limit 20 = 20/20/5 with no duplicates
    const cursorRecipient = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd300';
    await pool.query(`
        INSERT INTO auth.users (id, email, handle, display_name, status)
        VALUES ('${cursorRecipient}', 'cursor_rcp@winkey.vn', 'cursor_rcp', 'Cursor Walk', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
      `);

    for (let i = 0; i < 45; i++) {
      await pool.query(`
          INSERT INTO social.notifications (id, user_id, actor_id, kind, video_id, comment_id, created_at)
          VALUES ('${uuidv7()}', '${cursorRecipient}', '${n1UserA}', 'NEW_SUBSCRIBER', NULL, NULL, now() - interval '${45 - i} seconds')
          ON CONFLICT DO NOTHING;
        `);
    }

    const page1Res = await app.inject({
      method: 'GET',
      url: '/v1/notifications?limit=20',
      headers: { 'x-user-id': cursorRecipient },
    });
    expect(page1Res.statusCode).toBe(200);
    const page1Body = page1Res.json();
    expect(validateNotificationPage(page1Body)).toBe(true);
    expect(page1Body.items.length).toBe(20);
    expect(page1Body.next_cursor).not.toBeNull();

    const page2Res = await app.inject({
      method: 'GET',
      url: `/v1/notifications?limit=20&cursor=${encodeURIComponent(page1Body.next_cursor)}`,
      headers: { 'x-user-id': cursorRecipient },
    });
    expect(page2Res.statusCode).toBe(200);
    const page2Body = page2Res.json();
    expect(validateNotificationPage(page2Body)).toBe(true);
    expect(page2Body.items.length).toBe(20);
    expect(page2Body.next_cursor).not.toBeNull();

    const page3Res = await app.inject({
      method: 'GET',
      url: `/v1/notifications?limit=20&cursor=${encodeURIComponent(page2Body.next_cursor)}`,
      headers: { 'x-user-id': cursorRecipient },
    });
    expect(page3Res.statusCode).toBe(200);
    const page3Body = page3Res.json();
    expect(validateNotificationPage(page3Body)).toBe(true);
    expect(page3Body.items.length).toBe(5);
    expect(page3Body.next_cursor).toBeNull();

    const allCursorIds = [
      ...page1Body.items.map((i: any) => i.id),
      ...page2Body.items.map((i: any) => i.id),
      ...page3Body.items.map((i: any) => i.id),
    ];
    expect(new Set(allCursorIds).size).toBe(45);

    // 6. Unread filter
    // Mark 5 notifications as read
    const idsToMark = page1Body.items.slice(0, 5).map((i: any) => i.id);
    await pool.query('UPDATE social.notifications SET read_at = now() WHERE id = ANY($1::uuid[])', [
      idsToMark,
    ]);

    const unreadRes = await app.inject({
      method: 'GET',
      url: '/v1/notifications?limit=50&unread=true',
      headers: { 'x-user-id': cursorRecipient },
    });
    expect(unreadRes.statusCode).toBe(200);
    const unreadBody = unreadRes.json();
    expect(unreadBody.items.length).toBe(40);
    for (const item of unreadBody.items) {
      expect(item.read_at).toBeNull();
    }

    // 7. Unread Count capped at 100 (+ capped=true at 101)
    const countRecipient = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd400';
    await pool.query(`
        INSERT INTO auth.users (id, email, handle, display_name, status)
        VALUES ('${countRecipient}', 'count_rcp@winkey.vn', 'count_rcp', 'Count Recipient', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
      `);

    for (let i = 0; i < 101; i++) {
      await pool.query(`
          INSERT INTO social.notifications (id, user_id, actor_id, kind, video_id, comment_id, created_at)
          VALUES ('${uuidv7()}', '${countRecipient}', '${n1UserA}', 'NEW_SUBSCRIBER', NULL, NULL, now() - interval '${i} seconds')
          ON CONFLICT DO NOTHING;
        `);
    }

    const count101Res = await app.inject({
      method: 'GET',
      url: '/v1/notifications/unread-count',
      headers: { 'x-user-id': countRecipient },
    });
    expect(count101Res.statusCode).toBe(200);
    const count101Body = count101Res.json();
    expect(validateUnreadCount(count101Body)).toBe(true);
    expect(count101Body).toEqual({ count: 100, capped: true });

    // Mark 1 as read -> now exactly 100 unread -> capped: false
    const oneNotifRes = await pool.query(
      'SELECT id FROM social.notifications WHERE user_id = $1 LIMIT 1',
      [countRecipient],
    );
    await pool.query('UPDATE social.notifications SET read_at = now() WHERE id = $1', [
      oneNotifRes.rows[0].id,
    ]);

    const count100Res = await app.inject({
      method: 'GET',
      url: '/v1/notifications/unread-count',
      headers: { 'x-user-id': countRecipient },
    });
    expect(count100Res.statusCode).toBe(200);
    expect(count100Res.json()).toEqual({ count: 100, capped: false });

    // 8. Mark by ids and by up_to, error cases
    // 8a. 401 without identity
    const noAuthRes = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      payload: { ids: [uuidv7()] },
    });
    expect(noAuthRes.statusCode).toBe(401);

    // 8b. 400 on both ids and up_to
    const bothRes = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: { 'x-user-id': countRecipient },
      payload: { ids: [uuidv7()], up_to: new Date().toISOString() },
    });
    expect(bothRes.statusCode).toBe(400);
    expect(validateProblem(bothRes.json())).toBe(true);

    // 8c. 400 on neither
    const neitherRes = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: { 'x-user-id': countRecipient },
      payload: {},
    });
    expect(neitherRes.statusCode).toBe(400);
    expect(validateProblem(neitherRes.json())).toBe(true);

    // 8d. 400 on 101 ids
    const ids101 = Array.from({ length: 101 }, () => uuidv7());
    const maxIdsRes = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: { 'x-user-id': countRecipient },
      payload: { ids: ids101 },
    });
    expect(maxIdsRes.statusCode).toBe(400);
    expect(validateProblem(maxIdsRes.json())).toBe(true);

    // 8e. Mark by ids: foreign id ignored, read_at unchanged on repeat
    const unread2Rows = await pool.query(
      'SELECT id FROM social.notifications WHERE user_id = $1 AND read_at IS NULL LIMIT 2',
      [countRecipient],
    );
    const targetId1 = unread2Rows.rows[0].id;
    const targetId2 = unread2Rows.rows[1].id;
    const foreignId = uuidv7(); // id of someone else

    const markRes = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: { 'x-user-id': countRecipient },
      payload: { ids: [targetId1, targetId2, foreignId] },
    });
    expect(markRes.statusCode).toBe(204);

    const checkMarked = await pool.query(
      'SELECT id, read_at FROM social.notifications WHERE id IN ($1, $2)',
      [targetId1, targetId2],
    );
    expect(checkMarked.rows[0].read_at).not.toBeNull();
    expect(checkMarked.rows[1].read_at).not.toBeNull();
    const firstReadAt = checkMarked.rows[0].read_at;

    // Repeat mark call -> read_at unchanged
    await new Promise((r) => setTimeout(r, 100));
    const repeatMarkRes = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: { 'x-user-id': countRecipient },
      payload: { ids: [targetId1] },
    });
    expect(repeatMarkRes.statusCode).toBe(204);
    const checkRepeat = await pool.query('SELECT read_at FROM social.notifications WHERE id = $1', [
      targetId1,
    ]);
    expect(new Date(checkRepeat.rows[0].read_at).getTime()).toBe(new Date(firstReadAt).getTime());

    // 8f. Mark by up_to
    const markUpToDate = new Date().toISOString();
    const markUpToRes = await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: { 'x-user-id': countRecipient },
      payload: { up_to: markUpToDate },
    });
    expect(markUpToRes.statusCode).toBe(204);

    const remainingUnread = await pool.query(
      'SELECT count(*)::int as count FROM social.notifications WHERE user_id = $1 AND read_at IS NULL',
      [countRecipient],
    );
    expect(Number(remainingUnread.rows[0].count)).toBe(0);

    // 9. Janitor: deletes only rows older than retention and only one of two concurrent runs gets the lock
    const janitorOldId = uuidv7();
    const janitorNewId = uuidv7();
    await pool.query(`
        INSERT INTO social.notifications (id, user_id, actor_id, kind, video_id, comment_id, created_at)
        VALUES
          ('${janitorOldId}', '${n1Owner}', '${n1UserA}', 'NEW_SUBSCRIBER', NULL, NULL, now() - interval '95 days'),
          ('${janitorNewId}', '${n1Owner}', '${n1UserA}', 'NEW_SUBSCRIBER', NULL, NULL, now() - interval '10 days')
        ON CONFLICT DO NOTHING;
      `);

    const janitor = new NotificationsJanitor({ pool, retentionDays: 90 });

    // Concurrency check: hold lock from separate client
    const lockClient = await pool.connect();
    try {
      const lockRes = await lockClient.query('SELECT pg_try_advisory_lock($1) as locked', [
        NOTIFICATIONS_JANITOR_LOCK_KEY,
      ]);
      expect(lockRes.rows[0].locked).toBe(true);

      // While locked, janitor run should skip and return 0
      const skippedDeleted = await janitor.runOnce();
      expect(skippedDeleted).toBe(0);

      // Unlock
      await lockClient.query('SELECT pg_advisory_unlock($1)', [NOTIFICATIONS_JANITOR_LOCK_KEY]);
    } finally {
      lockClient.release();
    }

    // Now janitor runs alone and deletes the 95-day-old notification
    const deletedCount = await janitor.runOnce();
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    const checkOld = await pool.query('SELECT * FROM social.notifications WHERE id = $1', [
      janitorOldId,
    ]);
    expect(checkOld.rows.length).toBe(0);

    const checkNew = await pool.query('SELECT * FROM social.notifications WHERE id = $1', [
      janitorNewId,
    ]);
    expect(checkNew.rows.length).toBe(1);
  }, 120_000);
});
