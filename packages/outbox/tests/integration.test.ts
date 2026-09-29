import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connect, StringCodec, type NatsConnection } from 'nats';
import { enqueue } from '../src/enqueue.js';
import { OutboxRelay } from '../src/relay.js';
import type { EventEnvelope } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sc = StringCodec();

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
      if (file.startsWith('000001') || file.startsWith('000002')) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        await client.query(sql);
      }
    }
  } finally {
    client.release();
  }
}

describe('Outbox Integration (Real PostgreSQL 17 + NATS JetStream)', () => {
  let pool: pg.Pool | null = null;
  let nc: NatsConnection | null = null;
  let stopPgContainer: (() => Promise<void>) | null = null;
  let stopNatsContainer: (() => Promise<void>) | null = null;
  let isReady = false;

  beforeEach((ctx) => {
    if (!isReady) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail(
          'Real PostgreSQL 17 + NATS required by WINKEY_REQUIRE_DOCKER=1 but unavailable',
        );
      }
      ctx.skip();
    }
  });

  beforeAll(async () => {
    let dbUrl =
      process.env.TEST_DATABASE_URL ||
      (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432')
        ? process.env.DATABASE_URL
        : null);
    let natsUrl =
      process.env.TEST_NATS_URL ||
      (process.env.NATS_URL && !process.env.NATS_URL.includes('localhost:4222')
        ? process.env.NATS_URL
        : null);

    if (!dbUrl) {
      try {
        const tcPg = await import('@testcontainers/postgresql');
        const pgContainer = await new tcPg.PostgreSqlContainer('postgres:17-alpine')
          .withDatabase('winkey')
          .withUsername('winkey')
          .withPassword('winkey')
          .start();
        dbUrl = pgContainer.getConnectionUri();
        stopPgContainer = async () => {
          await pgContainer.stop();
        };
      } catch {
        // Docker or testcontainers unavailable
      }
    }

    if (!natsUrl) {
      try {
        const { GenericContainer } = await import('testcontainers');
        const natsContainer = await new GenericContainer('nats:2.10-alpine')
          .withCommand(['-js', '-sd', '/data'])
          .withExposedPorts(4222)
          .start();
        const mappedPort = natsContainer.getMappedPort(4222);
        const host = natsContainer.getHost();
        natsUrl = 'nats://' + host + ':' + mappedPort;
        stopNatsContainer = async () => {
          await natsContainer.stop();
        };
      } catch {
        // Docker or testcontainers unavailable
      }
    }

    if (!dbUrl || !natsUrl) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail(
          'Real PostgreSQL 17 + NATS required by WINKEY_REQUIRE_DOCKER=1 but unavailable',
        );
      }
      return;
    }

    try {
      pool = new pg.Pool({ connectionString: dbUrl });
      await pool.query('SELECT 1');

      nc = await connect({ servers: natsUrl });

      const repoRoot = findRepoRoot();
      await applyMigrations(pool, path.join(repoRoot, 'db', 'migrations'));

      const jsm = await nc.jetstreamManager();
      await jsm.streams.add({
        name: 'USER',
        subjects: ['user.>'],
      });

      isReady = true;
    } catch (err) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail('Failed initializing PG or NATS: ' + err);
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (nc) {
      await nc.drain();
      await nc.close();
    }
    if (pool) {
      await pool.end();
    }
    if (stopPgContainer) {
      await stopPgContainer();
    }
    if (stopNatsContainer) {
      await stopNatsContainer();
    }
  }, 60_000);

  it('an enqueue in a rolled-back transaction publishes nothing', async () => {
    if (!pool || !nc) return;

    const sub = nc.subscribe('user.rollback_test');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await enqueue(client, 'auth', 'user.rollback_test', {
        user_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9999',
        handle: 'never_saved',
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const relay = new OutboxRelay({
      db: pool,
      natsConnection: nc,
      schema: 'auth',
      batchSize: 10,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const processed = await relay.processBatch();
    expect(processed).toBe(0);

    expect(sub.getProcessed()).toBe(0);
    sub.unsubscribe();

    const res = await pool.query(
      "SELECT count(*) as count FROM auth.outbox WHERE subject = 'user.rollback_test'",
    );
    expect(Number(res.rows[0].count)).toBe(0);
  }, 60_000);

  it('a committed transaction is delivered exactly once with Nats-Msg-Id set and semantic payload matches', async () => {
    if (!pool || !nc) return;

    const sub = nc.subscribe('user.registered');

    let envelope: EventEnvelope | undefined;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      envelope = await enqueue(
        client,
        'auth',
        'user.registered',
        {
          user_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0001',
          handle: 'test_user',
          method: 'password',
          tags: ['creator', 'viewer'],
        },
        { producer: 'auth-svc', version: 1 },
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const relay = new OutboxRelay({
      db: pool,
      natsConnection: nc,
      schema: 'auth',
      batchSize: 10,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const processed = await relay.processBatch();
    expect(processed).toBe(1);

    const receivedMsg = await (async () => {
      for await (const m of sub) {
        return m;
      }
      throw new Error('Expected NATS message not received');
    })();

    expect(receivedMsg.headers?.get('Nats-Msg-Id')).toBe(envelope.event_id);

    const receivedPayload = JSON.parse(sc.decode(receivedMsg.data));
    expect(receivedPayload.event_id).toBe(envelope.event_id);
    expect(receivedPayload.type).toBe('user.registered');
    expect(receivedPayload.producer).toBe('auth-svc');
    expect(receivedPayload.version).toBe(1);
    expect(receivedPayload.data).toEqual({
      user_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0001',
      handle: 'test_user',
      method: 'password',
      tags: ['creator', 'viewer'],
    });

    const dbRow = await pool.query('SELECT published_at FROM auth.outbox WHERE event_id = $1', [
      envelope.event_id,
    ]);
    expect(dbRow.rows.length).toBe(1);
    expect(dbRow.rows[0].published_at).not.toBeNull();

    const secondProcessed = await relay.processBatch();
    expect(secondProcessed).toBe(0);
    expect(sub.getProcessed()).toBe(1);

    sub.unsubscribe();
  }, 60_000);
});
