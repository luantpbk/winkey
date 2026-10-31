import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import pg from 'pg';
import pino from 'pino';
import { Kysely, PostgresDialect } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { parse as parseYaml } from 'yaml';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import { loadEnv } from '../../src/config/env.js';
import { REDACT_PATHS } from '../../src/infra/logger.js';
import type { Database } from '../../src/db/types.js';
import { AttachmentsJanitor } from '../../src/janitor/attachments-janitor.js';
import {
  attachmentObjectKey,
  type AttachmentStorage,
} from '../../src/storage/attachment-storage.js';
import { generateTestDeviceKeys } from '../fixtures/keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

/** In-memory stand-in for the winkey-chat bucket: a "PUT" is `put(key, size)`; URLs are recognisable fakes. */
class MemoryStorage implements AttachmentStorage {
  objects = new Map<string, number>();
  failDeletes = new Set<string>();
  async presignPut(key: string, sizeBytes: number) {
    return {
      url: `https://s3.test/winkey-chat/${key}?X-Amz-Signature=SECRET-PUT-SIGNATURE`,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(sizeBytes) },
    };
  }
  async presignGet(key: string) {
    return `https://s3.test/winkey-chat/${key}?X-Amz-Signature=SECRET-GET-SIGNATURE`;
  }
  async headSize(key: string) {
    return this.objects.get(key) ?? null;
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async deleteObjects(keys: string[]) {
    const failed: string[] = [];
    for (const k of keys) {
      if (this.failDeletes.has(k)) failed.push(k);
      else this.objects.delete(k);
    }
    return failed;
  }
  put(key: string, size: number) {
    this.objects.set(key, size);
  }
}

describe('SOC-3b attachments and key backup on real PostgreSQL 17', () => {
  let pool: pg.Pool | null = null;
  let db: Kysely<Database> | null = null;
  let app: FastifyInstance | null = null;
  let stopPg: (() => Promise<void>) | null = null;
  const storage = new MemoryStorage();
  const logs: string[] = [];
  const schema: Record<string, ValidateFunction> = {};

  beforeEach((ctx) => {
    if (!app) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail('Real PostgreSQL required by WINKEY_REQUIRE_DOCKER=1 but unavailable');
      }
      ctx.skip();
    }
  });

  beforeAll(async () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as (a: unknown) => void)(ajv);
    const common = parseYaml(
      fs.readFileSync(path.join(repoRoot, 'contracts/openapi/common.yaml'), 'utf8'),
    );
    const chat = parseYaml(
      fs.readFileSync(path.join(repoRoot, 'contracts/openapi/chat.v1.yaml'), 'utf8'),
    );
    common.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
    chat.$id = 'https://winkey.vn/contracts/openapi/chat.v1.yaml';
    ajv.addSchema(common);
    ajv.addSchema(chat);
    for (const name of [
      'AttachmentUpload',
      'Attachment',
      'AttachmentDownload',
      'KeyBackup',
      'Message',
    ]) {
      schema[name] = ajv.getSchema(
        `https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/${name}`,
      )!;
    }
    schema.Problem = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/Problem',
    )!;

    let dbUrl = process.env.TEST_DATABASE_URL ?? null;
    if (!dbUrl) {
      try {
        const tcPg = await import('@testcontainers/postgresql');
        const container = await new tcPg.PostgreSqlContainer('postgres:17-alpine')
          .withDatabase('winkey_chat_soc3b')
          .withUsername('winkey')
          .withPassword('winkey')
          .start();
        dbUrl = container.getConnectionUri();
        stopPg = async () => {
          await container.stop();
        };
      } catch {
        return;
      }
    }

    pool = new pg.Pool({ connectionString: dbUrl });
    const ignoreAdminShutdown = (err: Error & { code?: string }) => {
      if (err.code !== '57P01') throw err;
    };
    pool.on('error', ignoreAdminShutdown);
    pool.on('connect', (client) => client.on('error', ignoreAdminShutdown));
    const applied = await pool.query("SELECT to_regclass('chat.attachments') IS NOT NULL AS done");
    if (!applied.rows[0].done) {
      const dir = path.join(repoRoot, 'db/migrations');
      for (const f of fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.up.sql'))
        .sort()) {
        await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
    }
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

    const loggerInstance = pino(
      { level: 'trace', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      new Writable({
        write(chunk, _enc, cb) {
          logs.push(chunk.toString());
          cb();
        },
      }),
    );
    app = await buildApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db,
      storage,
      loggerInstance,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    await stopPg?.();
  });

  // --- helpers -------------------------------------------------------------------------------------------------

  async function user(label: string): Promise<{ id: string; device: string }> {
    const id = uuidv7();
    await pool!.query(
      `INSERT INTO auth.users (id, email, handle, display_name) VALUES ($1, $2, $3, $4)`,
      [id, `${label}-${id}@test.local`, `${label}_${id.slice(-8)}`.slice(0, 30), label],
    );
    const keys = generateTestDeviceKeys(uuidv7(), id, `${label} device`, false);
    const res = await app!.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${keys.deviceId}`,
      headers: { 'x-user-id': id },
      payload: {
        display_name: keys.displayName,
        curve25519_key: keys.curve25519Key,
        ed25519_key: keys.ed25519Key,
        signature: keys.signature,
      },
    });
    expect([200, 201]).toContain(res.statusCode);
    return { id, device: keys.deviceId };
  }

  /** A conversation where everyone is ACTIVE (each invitee follows the creator). */
  async function conversation(
    owner: { id: string },
    others: Array<{ id: string }>,
    kind = 'GROUP',
  ) {
    for (const o of others) {
      await pool!.query(
        'INSERT INTO social.subscriptions (subscriber_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [o.id, owner.id],
      );
    }
    const res = await app!.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': owner.id },
      payload: {
        kind,
        user_ids: others.map((o) => o.id),
        ...(kind === 'GROUP' ? { title: 'Nhóm' } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function reserve(conv: string, u: { id: string; device: string }, size: number) {
    return app!.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${conv}/attachments`,
      headers: { 'x-user-id': u.id },
      payload: { sender_device_id: u.device, size_bytes: size },
    });
  }

  /** Reserve, "PUT" the bytes and complete; returns the attachment id. */
  async function uploaded(conv: string, u: { id: string; device: string }, size = 1000) {
    const res = await reserve(conv, u, size);
    expect(res.statusCode).toBe(201);
    const id = res.json().attachment.id as string;
    storage.put(attachmentObjectKey(conv, id), size);
    const done = await complete(conv, u, id);
    expect(done.statusCode).toBe(200);
    return id;
  }

  function complete(conv: string, u: { id: string }, id: string) {
    return app!.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${conv}/attachments/${id}/complete`,
      headers: { 'x-user-id': u.id },
    });
  }

  function send(conv: string, u: { id: string; device: string }, attachmentIds?: string[]) {
    return app!.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${conv}/messages`,
      headers: { 'x-user-id': u.id },
      payload: {
        client_msg_id: uuidv7(),
        sender_device_id: u.device,
        megolm_session_id: 'session-1',
        ciphertext: 'MEGOLM-CIPHERTEXT-SECRET',
        ...(attachmentIds ? { attachment_ids: attachmentIds } : {}),
      },
    });
  }

  function download(conv: string, u: { id: string }, id: string) {
    return app!.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${conv}/attachments/${id}/download`,
      headers: { 'x-user-id': u.id },
    });
  }

  // --- attachments ---------------------------------------------------------------------------------------------

  it('create → PUT → complete → send → list → download, every body matching chat.v1.yaml', async () => {
    const alice = await user('alice');
    const bob = await user('bob');
    const conv = await conversation(alice, [bob], 'DIRECT');

    const created = await reserve(conv, alice, 4096);
    expect(created.statusCode).toBe(201);
    expect(schema.AttachmentUpload!(created.json())).toBe(true);
    expect(created.json().upload_headers).toEqual({
      'Content-Type': 'application/octet-stream',
      'Content-Length': '4096',
    });
    expect(created.json().attachment.state).toBe('PENDING');
    const id = created.json().attachment.id as string;

    // Not uploaded yet.
    const early = await complete(conv, alice, id);
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('UPLOAD_INCOMPLETE');

    storage.put(attachmentObjectKey(conv, id), 4096);
    expect((await complete(conv, bob, id)).statusCode).toBe(403);
    const done = await complete(conv, alice, id);
    expect(done.statusCode).toBe(200);
    expect(schema.Attachment!(done.json())).toBe(true);
    expect(done.json().state).toBe('UPLOADED');
    expect((await complete(conv, alice, id)).json().state).toBe('UPLOADED'); // idempotent

    const sent = await send(conv, alice, [id]);
    expect(sent.statusCode).toBe(201);
    expect(schema.Message!(sent.json())).toBe(true);
    expect(sent.json().attachments.map((a: { id: string }) => a.id)).toEqual([id]);

    const list = await app!.inject({
      method: 'GET',
      url: `/v1/chat/conversations/${conv}/messages`,
      headers: { 'x-user-id': bob.id },
    });
    const msgs = list.json().items as Array<{ kind: string; attachments: Array<{ id: string }> }>;
    for (const m of msgs) expect(schema.Message!(m)).toBe(true);
    expect(msgs.find((m) => m.kind === 'ENCRYPTED')!.attachments.map((a) => a.id)).toEqual([id]);
    expect(msgs.find((m) => m.kind === 'SYSTEM')!.attachments).toEqual([]);

    const dl = await download(conv, bob, id);
    expect(dl.statusCode).toBe(200);
    expect(schema.AttachmentDownload!(dl.json())).toBe(true);
    expect(dl.json().size_bytes).toBe(4096);
  });

  it('a wrong-size upload is deleted and refused', async () => {
    const alice = await user('alice');
    const bob = await user('bob');
    const conv = await conversation(alice, [bob], 'DIRECT');
    const id = (await reserve(conv, alice, 100)).json().attachment.id as string;
    storage.put(attachmentObjectKey(conv, id), 99);
    const res = await complete(conv, alice, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('UPLOAD_INCOMPLETE');
    expect(storage.objects.has(attachmentObjectKey(conv, id))).toBe(false);
  });

  it('enforces the 1 GiB quota of live attachments per user', async () => {
    const alice = await user('alice');
    const bob = await user('bob');
    const conv = await conversation(alice, [bob], 'DIRECT');
    // 1 GiB already reserved (41 × 25 MiB = 1025 MiB > 1 GiB, so stop at 40 = 1000 MiB, then 24 MiB = 1024 MiB).
    await pool!.query(
      `INSERT INTO chat.attachments (id, conversation_id, uploader_id, uploader_device_id, size_bytes, expires_at)
       SELECT gen_random_uuid(), $1, $2, $3, 26214400, now() + interval '1 day' FROM generate_series(1, 40)`,
      [conv, alice.id, alice.device],
    );
    expect((await reserve(conv, alice, 24 * 1024 * 1024)).statusCode).toBe(201);
    const over = await reserve(conv, alice, 1);
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('ATTACHMENT_QUOTA');
    // Expired rows do not count.
    await pool!.query(
      `UPDATE chat.attachments SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE uploader_id = $1`,
      [alice.id],
    );
    expect((await reserve(conv, alice, 1)).statusCode).toBe(201);
  });

  it('refuses attachments sent twice, from another conversation, expired, or by someone else', async () => {
    const alice = await user('alice');
    const bob = await user('bob');
    const conv = await conversation(alice, [bob], 'DIRECT');
    const other = await conversation(alice, [bob], 'GROUP');

    const id = await uploaded(conv, alice);
    expect((await send(conv, alice, [id])).statusCode).toBe(201);
    const twice = await send(conv, alice, [id]);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe('ATTACHMENT_UNAVAILABLE');

    const foreign = await uploaded(other, alice);
    expect((await send(conv, alice, [foreign])).json().code).toBe('ATTACHMENT_UNAVAILABLE');

    const bobs = await uploaded(conv, bob);
    expect((await send(conv, alice, [bobs])).json().code).toBe('ATTACHMENT_UNAVAILABLE');

    const expired = await uploaded(conv, alice);
    await pool!.query(
      `UPDATE chat.attachments SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE id = $1`,
      [expired],
    );
    const before = Number(
      (await pool!.query('SELECT last_seq FROM chat.conversations WHERE id = $1', [conv])).rows[0]
        .last_seq,
    );
    expect((await send(conv, alice, [expired])).json().code).toBe('ATTACHMENT_UNAVAILABLE');
    // The failed send rolled back: no seq was used.
    const after = Number(
      (await pool!.query('SELECT last_seq FROM chat.conversations WHERE id = $1', [conv])).rows[0]
        .last_seq,
    );
    expect(after).toBe(before);
    // Expired download → 410 for the uploader.
    const gone = await download(conv, alice, expired);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe('ATTACHMENT_EXPIRED');
    expect(schema.Problem!(gone.json())).toBe(true);
  });

  it("a member who joined after the message gets 404; an unsent attachment is the uploader's only", async () => {
    const alice = await user('alice');
    const bob = await user('bob');
    const carol = await user('carol');
    const group = await conversation(alice, [bob], 'GROUP');
    const id = await uploaded(group, alice);
    expect((await send(group, alice, [id])).statusCode).toBe(201);

    await pool!.query(
      'INSERT INTO social.subscriptions (subscriber_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [carol.id, alice.id],
    );
    const added = await app!.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${group}/members`,
      headers: { 'x-user-id': alice.id },
      payload: { user_ids: [carol.id] },
    });
    expect(added.statusCode).toBe(200);
    expect((await download(group, carol, id)).statusCode).toBe(404);
    expect((await download(group, bob, id)).statusCode).toBe(200);

    const unsent = await uploaded(group, alice);
    expect((await download(group, alice, unsent)).statusCode).toBe(200);
    expect((await download(group, bob, unsent)).statusCode).toBe(404);
  });

  it('deleting the message deletes its attachments and their objects', async () => {
    const alice = await user('alice');
    const bob = await user('bob');
    const conv = await conversation(alice, [bob], 'DIRECT');
    const id = await uploaded(conv, alice);
    const sent = await send(conv, alice, [id]);
    const seq = sent.json().seq as number;
    const del = await app!.inject({
      method: 'DELETE',
      url: `/v1/chat/conversations/${conv}/messages/${seq}`,
      headers: { 'x-user-id': alice.id },
    });
    expect(del.statusCode).toBe(204);
    expect(storage.objects.has(attachmentObjectKey(conv, id))).toBe(false);
    expect((await pool!.query('SELECT 1 FROM chat.attachments WHERE id = $1', [id])).rowCount).toBe(
      0,
    );
    expect((await download(conv, bob, id)).statusCode).toBe(404);
  });

  it('the janitor removes expired and 24 h-unlinked attachments, and retries failed object deletes', async () => {
    const alice = await user('alice');
    const bob = await user('bob');
    const conv = await conversation(alice, [bob], 'DIRECT');
    const fresh = await uploaded(conv, alice);
    const stale = await uploaded(conv, alice);
    const linked = await uploaded(conv, alice);
    const stuck = await uploaded(conv, alice);
    expect((await send(conv, alice, [linked])).statusCode).toBe(201);
    await pool!.query(
      `UPDATE chat.attachments SET created_at = now() - interval '25 hours' WHERE id = ANY($1::uuid[])`,
      [[stale, linked, stuck]],
    );
    storage.failDeletes.add(attachmentObjectKey(conv, stuck));

    const janitor = new AttachmentsJanitor({ pool: pool!, storage });
    await janitor.runOnce();
    const left = (
      await pool!.query('SELECT id FROM chat.attachments WHERE id = ANY($1::uuid[])', [
        [fresh, stale, linked, stuck],
      ])
    ).rows.map((r) => r.id);
    expect(left.sort()).toEqual([fresh, linked, stuck].sort());
    expect(storage.objects.has(attachmentObjectKey(conv, stale))).toBe(false);

    storage.failDeletes.clear();
    await janitor.runOnce();
    expect(
      (await pool!.query('SELECT 1 FROM chat.attachments WHERE id = $1', [stuck])).rowCount,
    ).toBe(0);

    // 30 days later even the linked one has expired.
    await janitor.runOnce(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    expect(
      (await pool!.query('SELECT 1 FROM chat.attachments WHERE id = $1', [linked])).rowCount,
    ).toBe(0);
  });

  it('answers 503 when the bucket is not configured, and checks membership and devices', async () => {
    const alice = await user('alice');
    const bob = await user('bob');
    const conv = await conversation(alice, [bob], 'DIRECT');
    const noS3 = await buildApp({ env: loadEnv({ NODE_ENV: 'test' }), db: db!, storage: null });
    try {
      const res = await noS3.inject({
        method: 'POST',
        url: `/v1/chat/conversations/${conv}/attachments`,
        headers: { 'x-user-id': alice.id },
        payload: { sender_device_id: alice.device, size_bytes: 10 },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('ATTACHMENTS_UNAVAILABLE');
    } finally {
      await noS3.close();
    }
    const stranger = await user('stranger');
    expect((await reserve(conv, stranger, 10)).statusCode).toBe(404);
    const wrongDevice = await reserve(conv, { id: alice.id, device: bob.device }, 10);
    expect(wrongDevice.statusCode).toBe(403);
    expect(wrongDevice.json().code).toBe('DEVICE_NOT_YOURS');
    expect((await reserve(conv, alice, 26214401)).statusCode).toBe(400);
  });

  // --- key backup ----------------------------------------------------------------------------------------------

  const authData = {
    kdf: 'argon2id',
    salt: 'c2FsdA',
    m_kib: 65536,
    t: 3,
    p: 1,
    wrapped_key: 'd3JhcA',
    iv: 'aXY',
    key_check: 'Y2hr',
  };
  function putBackup(u: { id: string }, body: Record<string, unknown>) {
    return app!.inject({
      method: 'PUT',
      url: '/v1/chat/key-backup',
      headers: { 'x-user-id': u.id },
      payload: body,
    });
  }
  function putSessions(u: { id: string }, version: number, sessions: unknown[]) {
    return app!.inject({
      method: 'PUT',
      url: '/v1/chat/key-backup/sessions',
      headers: { 'x-user-id': u.id },
      payload: { version, sessions },
    });
  }
  const conv1 = '0192f5e4-7c1a-7b3e-9d2a-00000000c001';
  const conv2 = '0192f5e4-7c1a-7b3e-9d2a-00000000c002';

  it('creates once, refuses a second create, and replace drops the sessions', async () => {
    const alice = await user('alice');
    const created = await putBackup(alice, { algorithm: 'winkey.backup.v1', auth_data: authData });
    expect(created.statusCode).toBe(201);
    expect(schema.KeyBackup!(created.json())).toBe(true);
    expect(created.json().version).toBe(1);

    const again = await putBackup(alice, { algorithm: 'winkey.backup.v1', auth_data: authData });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('BACKUP_EXISTS');

    expect(
      (
        await putSessions(alice, 1, [
          { conversation_id: conv1, session_id: 's1', first_message_index: 0, ciphertext: 'QUJD' },
        ])
      ).json(),
    ).toEqual({ stored: 1, kept: 0 });
    const got = await app!.inject({
      method: 'GET',
      url: '/v1/chat/key-backup',
      headers: { 'x-user-id': alice.id },
    });
    expect(schema.KeyBackup!(got.json())).toBe(true);
    expect(got.json().session_count).toBe(1);

    const replaced = await putBackup(alice, {
      algorithm: 'winkey.backup.v1',
      auth_data: { ...authData, salt: 'bmV3' },
      replace: true,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().version).toBe(2);
    expect(replaced.json().session_count).toBe(0);
    const mismatch = await putSessions(alice, 1, [
      { conversation_id: conv1, session_id: 's1', first_message_index: 0, ciphertext: 'QUJD' },
    ]);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe('BACKUP_VERSION_MISMATCH');

    expect(
      (
        await putBackup(alice, {
          algorithm: 'winkey.backup.v1',
          auth_data: { big: 'x'.repeat(5000) },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await putBackup(alice, {
          algorithm: 'winkey.backup.v1',
          auth_data: ['not', 'an', 'object'],
        })
      ).statusCode,
    ).toBe(400);

    const del = await app!.inject({
      method: 'DELETE',
      url: '/v1/chat/key-backup',
      headers: { 'x-user-id': alice.id },
    });
    expect(del.statusCode).toBe(204);
    expect(
      (
        await app!.inject({
          method: 'GET',
          url: '/v1/chat/key-backup',
          headers: { 'x-user-id': alice.id },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('keeps the key with the lowest first_message_index; an equal one replaces', async () => {
    const alice = await user('alice');
    await putBackup(alice, { algorithm: 'winkey.backup.v1', auth_data: authData });
    const s = (index: number, ct: string) => ({
      conversation_id: conv1,
      session_id: 'sess',
      first_message_index: index,
      ciphertext: ct,
    });
    expect((await putSessions(alice, 1, [s(5, 'RklWRQ')])).json()).toEqual({ stored: 1, kept: 0 });
    expect((await putSessions(alice, 1, [s(9, 'TklORQ')])).json()).toEqual({ stored: 0, kept: 1 });
    expect((await putSessions(alice, 1, [s(5, 'U0FNRQ')])).json()).toEqual({ stored: 1, kept: 0 });
    expect((await putSessions(alice, 1, [s(2, 'VFdP')])).json()).toEqual({ stored: 1, kept: 0 });
    const row = await pool!.query(
      'SELECT first_message_index, ciphertext FROM chat.key_backup_sessions WHERE user_id = $1',
      [alice.id],
    );
    expect(row.rows).toEqual([{ first_message_index: 2, ciphertext: 'VFdP' }]);
    expect((await putSessions(alice, 1, [s(1, 'QQ'), s(1, 'Qg')])).json().code).toBe(
      'DUPLICATE_SESSION',
    );
  });

  it('pages sessions by (conversation_id, session_id) with an optional conversation filter', async () => {
    const alice = await user('alice');
    await putBackup(alice, { algorithm: 'winkey.backup.v1', auth_data: authData });
    const sessions = [conv2, conv1].flatMap((c) =>
      ['b', 'a', 'c'].map((id) => ({
        conversation_id: c,
        session_id: id,
        first_message_index: 0,
        ciphertext: 'QUJD',
      })),
    );
    expect((await putSessions(alice, 1, sessions)).json().stored).toBe(6);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Awaited<ReturnType<FastifyInstance['inject']>> = await app!.inject({
        method: 'GET',
        url: `/v1/chat/key-backup/sessions?version=1&limit=4${cursor ? `&cursor=${cursor}` : ''}`,
        headers: { 'x-user-id': alice.id },
      });
      expect(res.statusCode).toBe(200);
      seen.push(
        ...res
          .json()
          .items.map(
            (i: { conversation_id: string; session_id: string }) =>
              `${i.conversation_id.slice(-1)}${i.session_id}`,
          ),
      );
      cursor = res.json().next_cursor;
    } while (cursor);
    expect(seen).toEqual(['1a', '1b', '1c', '2a', '2b', '2c']);

    const filtered = await app!.inject({
      method: 'GET',
      url: `/v1/chat/key-backup/sessions?version=1&conversation_id=${conv2}`,
      headers: { 'x-user-id': alice.id },
    });
    expect(filtered.json().items).toHaveLength(3);
    const stale = await app!.inject({
      method: 'GET',
      url: '/v1/chat/key-backup/sessions?version=7',
      headers: { 'x-user-id': alice.id },
    });
    expect(stale.json().code).toBe('BACKUP_VERSION_MISMATCH');
  });

  it('never logs presigned URLs, auth_data or ciphertext', () => {
    const all = logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain('SECRET-PUT-SIGNATURE');
    expect(all).not.toContain('SECRET-GET-SIGNATURE');
    expect(all).not.toContain('wrapped_key');
    expect(all).not.toContain('MEGOLM-CIPHERTEXT-SECRET');
    expect(all).not.toContain('U0FNRQ');
  });
});
