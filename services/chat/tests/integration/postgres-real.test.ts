import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import type { Database } from '../../src/db/types.js';
import { generateTestDeviceKeys, generateTestOneTimeKeys } from '../fixtures/keys.js';
import { runToDevicePurgeIteration } from '../../src/janitor/to-device-purge-job.js';

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
      const sqlContent = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await client.query(sqlContent);
    }
  } finally {
    client.release();
  }
}

describe('Real PostgreSQL 17 Integration Tests (SOC-3a Chat Service)', () => {
  let pool: pg.Pool | null = null;
  let db: Kysely<Database> | null = null;
  let app: FastifyInstance | null = null;
  let stopPgContainer: (() => Promise<void>) | null = null;
  let isReady = false;

  beforeEach((ctx) => {
    if (!isReady) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail('Real PostgreSQL required by WINKEY_REQUIRE_DOCKER=1 but unavailable');
      }
      ctx.skip();
    }
  });

  beforeAll(async () => {
    let testDbUrl =
      process.env.TEST_DATABASE_URL ||
      (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432')
        ? process.env.DATABASE_URL
        : null);

    if (!testDbUrl) {
      try {
        const tcPg = await import('@testcontainers/postgresql');
        const pgContainer = await new tcPg.PostgreSqlContainer('postgres:17-alpine')
          .withDatabase('winkey_chat_test')
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

    if (!testDbUrl) {
      return;
    }

    try {
      pool = new pg.Pool({ connectionString: testDbUrl });
      // pool.end() resolves before its clients' sockets finish closing, so stopping the container
      // right after db.destroy() can deliver 57P01 (admin shutdown) to a client that has no
      // 'error' listener any more and crash the run. Ignore exactly that; anything else rethrows.
      const ignoreAdminShutdown = (err: Error & { code?: string }) => {
        if (err.code !== '57P01') throw err;
      };
      pool.on('error', ignoreAdminShutdown);
      pool.on('connect', (client) => client.on('error', ignoreAdminShutdown));
      const repoRoot = findRepoRoot();
      const migrationsDir = path.join(repoRoot, 'db', 'migrations');
      await applyMigrations(pool, migrationsDir);

      db = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool,
        }),
      });

      app = await buildApp({
        db,
      });

      isReady = true;
    } catch {
      isReady = false;
    }
  }, 60000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (db) {
      await db.destroy();
    }
    if (stopPgContainer) {
      await stopPgContainer();
    }
  });

  // Helper to create test user in auth.users (which feeds auth.public_profiles view)
  async function seedUser(userId: string, handle: string, name: string) {
    if (!pool) return;
    await pool.query(
      `INSERT INTO auth.users (id, email, handle, display_name, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${handle}@test.local`, handle, name],
    );
  }

  it('claims: 20 concurrent claims on a device with 10 OTKs yields 10 distinct OTKs + 10 fallback', async () => {
    if (!app || !db) return;

    const aliceId = uuidv7();
    const bobId = uuidv7();
    await seedUser(aliceId, 'alice_claim', 'Alice Claim');
    await seedUser(bobId, 'bob_claim', 'Bob Claim');

    // Register Alice device with fallback key
    const aliceKeys = generateTestDeviceKeys(uuidv7(), aliceId, 'Alice Claim Device', true);
    await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${aliceKeys.deviceId}`,
      headers: { 'x-user-id': aliceId },
      payload: {
        display_name: aliceKeys.displayName,
        curve25519_key: aliceKeys.curve25519Key,
        ed25519_key: aliceKeys.ed25519Key,
        signature: aliceKeys.signature,
        fallback_key: aliceKeys.fallbackKey,
      },
    });

    // Upload exactly 10 one-time keys
    const otks = generateTestOneTimeKeys(aliceKeys, 10, 1);
    await app.inject({
      method: 'POST',
      url: `/v1/chat/devices/${aliceKeys.deviceId}/one-time-keys`,
      headers: { 'x-user-id': aliceId },
      payload: { keys: otks },
    });

    // 20 concurrent claims from Bob
    const claimPromises = Array.from({ length: 20 }, () =>
      app!.inject({
        method: 'POST',
        url: '/v1/chat/keys/claim',
        headers: { 'x-user-id': bobId },
        payload: {
          device_ids: [aliceKeys.deviceId],
        },
      }),
    );

    const responses = await Promise.all(claimPromises);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    const claimedOneTimeKeys: string[] = [];
    let fallbackCount = 0;

    for (const res of responses) {
      const claimedDev = res.json().keys[0];
      if (!claimedDev.fallback) {
        claimedOneTimeKeys.push(claimedDev.key_id);
      } else {
        fallbackCount++;
        expect(claimedDev.key_id).toBe(aliceKeys.fallbackKey?.key_id);
      }
    }

    // Exactly 10 distinct OTKs claimed
    expect(claimedOneTimeKeys.length).toBe(10);
    const uniqueOtks = new Set(claimedOneTimeKeys);
    expect(uniqueOtks.size).toBe(10);

    // Remaining 10 received fallback key
    expect(fallbackCount).toBe(10);
  });

  it('device limits: max 10 active devices, reused key, immutable keys', async () => {
    if (!app || !db) return;

    const testUser = uuidv7();
    await seedUser(testUser, 'limit_user', 'Limit User');

    let d1: ReturnType<typeof generateTestDeviceKeys> | undefined;

    // Register 10 active devices
    for (let i = 1; i <= 10; i++) {
      const d = generateTestDeviceKeys(uuidv7(), testUser, `Device ${i}`, false);
      if (i === 1) d1 = d;
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/chat/devices/${d.deviceId}`,
        headers: { 'x-user-id': testUser },
        payload: {
          display_name: d.displayName,
          curve25519_key: d.curve25519Key,
          ed25519_key: d.ed25519Key,
          signature: d.signature,
        },
      });
      expect(res.statusCode).toBe(201);
    }

    // 11th active device registration fails with 409 TOO_MANY_DEVICES
    const d11 = generateTestDeviceKeys(uuidv7(), testUser, 'Device 11', false);
    const res11 = await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${d11.deviceId}`,
      headers: { 'x-user-id': testUser },
      payload: {
        display_name: d11.displayName,
        curve25519_key: d11.curve25519Key,
        ed25519_key: d11.ed25519Key,
        signature: d11.signature,
      },
    });
    expect(res11.statusCode).toBe(409);
    expect(res11.json().code).toBe('TOO_MANY_DEVICES');

    // Reusing existing identity key curve25519 for different user/device fails with 409 IDENTITY_KEY_IN_USE
    const otherUser = uuidv7();
    await seedUser(otherUser, 'other_user', 'Other User');
    const dReused = generateTestDeviceKeys(
      uuidv7(),
      otherUser,
      'Reused Key Device',
      false,
      d1!.curve25519Key,
    );
    const resReuse = await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${dReused.deviceId}`,
      headers: { 'x-user-id': otherUser },
      payload: {
        display_name: dReused.displayName,
        curve25519_key: dReused.curve25519Key,
        ed25519_key: dReused.ed25519Key,
        signature: dReused.signature,
      },
    });
    expect(resReuse.statusCode).toBe(409);
    expect(resReuse.json().code).toBe('IDENTITY_KEY_IN_USE');
  });

  it('conversations: 10 concurrent DIRECT conversation creates are idempotent', async () => {
    if (!app || !db) return;

    const u1 = uuidv7();
    const u2 = uuidv7();
    await seedUser(u1, 'direct_u1', 'Direct User 1');
    await seedUser(u2, 'direct_u2', 'Direct User 2');

    // u1 follows u2 (subscribed)
    await db
      .insertInto('social.subscriptions')
      .values({ subscriber_id: u1, channel_id: u2 })
      .onConflict((oc) => oc.columns(['subscriber_id', 'channel_id']).doNothing())
      .execute();

    const createPromises = Array.from({ length: 10 }, () =>
      app!.inject({
        method: 'POST',
        url: '/v1/chat/conversations',
        headers: { 'x-user-id': u1 },
        payload: {
          kind: 'DIRECT',
          user_ids: [u2],
        },
      }),
    );

    const responses = await Promise.all(createPromises);
    const convIds = new Set<string>();

    for (const res of responses) {
      expect([200, 201]).toContain(res.statusCode);
      convIds.add(res.json().id);
    }

    // Exactly 1 direct conversation created
    expect(convIds.size).toBe(1);

    // Database count is exactly 1
    const dbCount = await db
      .selectFrom('chat.conversations')
      .select(sql<string>`count(*)`.as('count'))
      .where('id', '=', Array.from(convIds)[0])
      .executeTakeFirstOrThrow();

    expect(Number(dbCount.count)).toBe(1);
  });

  it('messages: 50 concurrent sends preserve strictly contiguous seq', async () => {
    if (!app || !db) return;

    const sender = uuidv7();
    const peer = uuidv7();
    await seedUser(sender, 'msg_sender', 'Message Sender');
    await seedUser(peer, 'msg_peer', 'Message Peer');

    const dev = generateTestDeviceKeys(uuidv7(), sender, 'Sender Phone', false);
    await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${dev.deviceId}`,
      headers: { 'x-user-id': sender },
      payload: {
        display_name: dev.displayName,
        curve25519_key: dev.curve25519Key,
        ed25519_key: dev.ed25519Key,
        signature: dev.signature,
      },
    });

    const convRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': sender },
      payload: {
        kind: 'GROUP',
        title: 'Concurrent Seq Test',
        user_ids: [peer],
      },
    });
    expect(convRes.statusCode).toBe(201);
    const convId = convRes.json().id;

    // Send 50 messages concurrently
    const sendPromises = Array.from({ length: 50 }, (_, i) =>
      app!.inject({
        method: 'POST',
        url: `/v1/chat/conversations/${convId}/messages`,
        headers: { 'x-user-id': sender },
        payload: {
          client_msg_id: uuidv7(),
          sender_device_id: dev.deviceId,
          megolm_session_id: 'session_concurrent',
          ciphertext: `Ciphertext ${i}`,
        },
      }),
    );

    const responses = await Promise.all(sendPromises);
    const seqs: number[] = [];
    for (const res of responses) {
      expect(res.statusCode).toBe(201);
      seqs.push(res.json().seq);
    }

    seqs.sort((a, b) => a - b);
    expect(seqs.length).toBe(50);
    // seq = 1 is the conversation_created SYSTEM message; user messages get seq 2..51
    for (let i = 0; i < 50; i++) {
      expect(seqs[i]).toBe(i + 2);
    }
  });

  it('to-device purge job deletes rows older than 30 days', async () => {
    if (!db) return;

    const testDev = uuidv7();
    const sender = uuidv7();
    await seedUser(sender, 'sender_purge', 'Sender Purge');

    // Register recipient device in chat.devices so foreign key constraint is satisfied
    const devKeys = generateTestDeviceKeys(testDev, sender, 'Purge Device', false);
    await db
      .insertInto('chat.devices')
      .values({
        id: testDev,
        user_id: sender,
        display_name: devKeys.displayName,
        curve25519_key: devKeys.curve25519Key,
        ed25519_key: devKeys.ed25519Key,
        signature: devKeys.signature,
      })
      .execute();

    // Insert to-device row from 35 days ago
    const oldDate = new Date(Date.now() - 35 * 86400 * 1000);
    await db
      .insertInto('chat.to_device')
      .values({
        recipient_device_id: testDev,
        sender_id: sender,
        sender_device_id: uuidv7(),
        ciphertext: 'old_ciphertext',
        created_at: oldDate,
      })
      .execute();

    // Insert to-device row from 5 days ago
    const newDate = new Date(Date.now() - 5 * 86400 * 1000);
    await db
      .insertInto('chat.to_device')
      .values({
        recipient_device_id: testDev,
        sender_id: sender,
        sender_device_id: uuidv7(),
        ciphertext: 'recent_ciphertext',
        created_at: newDate,
      })
      .execute();

    // Run purge iteration
    const purgedCount = await runToDevicePurgeIteration(pool!);
    expect(purgedCount).toBeGreaterThanOrEqual(1);

    // Check remaining rows
    const remaining = await db
      .selectFrom('chat.to_device')
      .selectAll()
      .where('recipient_device_id', '=', testDev)
      .execute();

    expect(remaining.length).toBe(1);
    expect(remaining[0].ciphertext).toBe('recent_ciphertext');
  });

  it('messages: cross-conversation client_msg_id reuse returns 409 CLIENT_MSG_ID_CONFLICT without 25P02', async () => {
    if (!app || !db) return;

    const sender = uuidv7();
    const peer1 = uuidv7();
    const peer2 = uuidv7();
    await seedUser(sender, 'cross_sender', 'Cross Sender');
    await seedUser(peer1, 'cross_peer1', 'Cross Peer 1');
    await seedUser(peer2, 'cross_peer2', 'Cross Peer 2');

    const dev = generateTestDeviceKeys(uuidv7(), sender, 'Sender Phone', false);
    await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${dev.deviceId}`,
      headers: { 'x-user-id': sender },
      payload: {
        display_name: dev.displayName,
        curve25519_key: dev.curve25519Key,
        ed25519_key: dev.ed25519Key,
        signature: dev.signature,
      },
    });

    const conv1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': sender },
      payload: { kind: 'GROUP', title: 'Conv 1', user_ids: [peer1] },
    });
    const conv2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': sender },
      payload: { kind: 'GROUP', title: 'Conv 2', user_ids: [peer2] },
    });

    const sharedClientMsgId = uuidv7();

    const send1 = await app.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${conv1.json().id}/messages`,
      headers: { 'x-user-id': sender },
      payload: {
        client_msg_id: sharedClientMsgId,
        sender_device_id: dev.deviceId,
        megolm_session_id: 'session_cross',
        ciphertext: 'Message in conv 1',
      },
    });
    expect(send1.statusCode).toBe(201);

    const send2 = await app.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${conv2.json().id}/messages`,
      headers: { 'x-user-id': sender },
      payload: {
        client_msg_id: sharedClientMsgId,
        sender_device_id: dev.deviceId,
        megolm_session_id: 'session_cross',
        ciphertext: 'Message in conv 2',
      },
    });
    expect(send2.statusCode).toBe(409);
    expect(send2.json().code).toBe('CLIENT_MSG_ID_CONFLICT');
  });

  it('read receipts (B3): markRead announces READ to other ACTIVE members; REQUESTED markers stay private', async () => {
    if (!app || !db) return;

    // A second app whose hints go to a capturing fake NATS connection.
    const published: { subject: string; payload: Record<string, unknown> }[] = [];
    const fakeNc = {
      isClosed: () => false,
      publish: (subject: string, data: Uint8Array) =>
        published.push({ subject, payload: JSON.parse(new TextDecoder().decode(data)) }),
    } as unknown as import('nats').NatsConnection;
    const appWithHints = await buildApp({ db, natsConnection: fakeNc });

    try {
      const a = uuidv7();
      const b = uuidv7();
      const c = uuidv7();
      await seedUser(a, `rr_a_${a.slice(-6)}`, 'Người A');
      await seedUser(b, `rr_b_${b.slice(-6)}`, 'Người B');
      await seedUser(c, `rr_c_${c.slice(-6)}`, 'Người C');
      // B follows A, so a DIRECT from A is ACTIVE for B; C does not, so it is a request for C.
      await db
        .insertInto('social.subscriptions')
        .values({ subscriber_id: b, channel_id: a })
        .onConflict((oc) => oc.columns(['subscriber_id', 'channel_id']).doNothing())
        .execute();

      const open = async (peer: string) => {
        const res = await appWithHints.inject({
          method: 'POST',
          url: '/v1/chat/conversations',
          headers: { 'x-user-id': a },
          payload: { kind: 'DIRECT', user_ids: [peer] },
        });
        expect([200, 201]).toContain(res.statusCode);
        return res.json().id as string;
      };
      const ab = await open(b);
      const ac = await open(c);
      for (const id of [ab, ac]) {
        await db
          .updateTable('chat.conversations')
          .set({ last_seq: '5' })
          .where('id', '=', id)
          .execute();
      }
      const markRead = (who: string, conv: string, seq: number) =>
        appWithHints.inject({
          method: 'POST',
          url: `/v1/chat/conversations/${conv}/read`,
          headers: { 'x-user-id': who },
          payload: { seq },
        });

      published.length = 0;
      expect((await markRead(b, ab, 3)).statusCode).toBe(204);
      const reads = published.filter((p) => p.payload.kind === 'READ');
      expect(reads).toEqual([
        {
          subject: `rt.chat.user.${a}`,
          payload: { kind: 'READ', conversation_id: ab, user_id: b, seq: 3 },
        },
      ]);

      // Not forward: no hint. Past last_seq: clamped to 5.
      published.length = 0;
      expect((await markRead(b, ab, 2)).statusCode).toBe(204);
      expect(published).toEqual([]);
      expect((await markRead(b, ab, 99)).statusCode).toBe(204);
      expect(published.map((p) => p.payload)).toEqual([
        { kind: 'READ', conversation_id: ab, user_id: b, seq: 5 },
      ]);

      // Members carry last_read_seq for ACTIVE members, in the single conversation and in the list.
      const one = await appWithHints.inject({
        method: 'GET',
        url: `/v1/chat/conversations/${ab}`,
        headers: { 'x-user-id': a },
      });
      expect(one.statusCode).toBe(200);
      const memberB = one.json().members.find((m: { user_id: string }) => m.user_id === b);
      expect(memberB).toMatchObject({ state: 'ACTIVE', last_read_seq: 5 });
      const list = await appWithHints.inject({
        method: 'GET',
        url: '/v1/chat/conversations?state=ACTIVE&limit=30',
        headers: { 'x-user-id': a },
      });
      const listed = list.json().items.find((x: { id: string }) => x.id === ab);
      expect(listed.members.find((m: { user_id: string }) => m.user_id === b).last_read_seq).toBe(
        5,
      );

      // C has not accepted: the marker is saved, never announced, and shown as null to A.
      published.length = 0;
      expect((await markRead(c, ac, 4)).statusCode).toBe(204);
      expect(published).toEqual([]);
      const saved = await db
        .selectFrom('chat.members')
        .select('last_read_seq')
        .where('conversation_id', '=', ac)
        .where('user_id', '=', c)
        .executeTakeFirstOrThrow();
      expect(Number(saved.last_read_seq)).toBe(4);
      const req = await appWithHints.inject({
        method: 'GET',
        url: `/v1/chat/conversations/${ac}`,
        headers: { 'x-user-id': a },
      });
      const memberC = req.json().members.find((m: { user_id: string }) => m.user_id === c);
      expect(memberC).toMatchObject({ state: 'REQUESTED', last_read_seq: null });
    } finally {
      await appWithHints.close();
    }
  });
});
