import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import _Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getDb } from '../../src/db/client.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { PEOPLE_SEARCH_MAX_RESULTS } from '../../src/routes/people.js';
const Ajv2020 = (_Ajv2020 as any).default ?? _Ajv2020;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'db', 'migrations'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Repository root (db/migrations) not found');
}

// Task SOC-6a: searchPeople on real PostgreSQL 17 (folding, blocks, ranking, cap, cursor, EXPLAIN).
describe('searchPeople on real PostgreSQL 17 (Task SOC-6a)', () => {
  let pool: pg.Pool | null = null;
  let app: FastifyInstance | null = null;
  let stopPg: (() => Promise<void>) | null = null;
  let validatePeoplePage: any;
  let validateProblem: any;

  const me = uuidv7();
  const friend = uuidv7(); // mutual follow
  const followed = uuidv7(); // I follow them
  const stranger = uuidv7();
  const blocker = uuidv7(); // blocks me
  const blockedByMe = uuidv7();
  const suspended = uuidv7();

  beforeEach((ctx) => {
    if (!app) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail('Real PostgreSQL 17 required by WINKEY_REQUIRE_DOCKER=1 but unavailable');
      }
      ctx.skip();
    }
  });

  beforeAll(async () => {
    const repoRoot = findRepoRoot();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as any)(ajv);
    const openapiDir = path.join(repoRoot, 'contracts', 'openapi');
    const common = parseYaml(fs.readFileSync(path.join(openapiDir, 'common.yaml'), 'utf8'));
    const social = parseYaml(fs.readFileSync(path.join(openapiDir, 'social.v1.yaml'), 'utf8'));
    common.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
    social.$id = 'https://winkey.vn/contracts/openapi/social.v1.yaml';
    ajv.addSchema(common);
    ajv.addSchema(social);
    validatePeoplePage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/PeoplePage',
    );
    validateProblem = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/Problem',
    );

    let dbUrl = process.env.TEST_DATABASE_URL ?? null;
    if (!dbUrl) {
      try {
        const tcPg = await import('@testcontainers/postgresql');
        const container = await new tcPg.PostgreSqlContainer('postgres:17-alpine')
          .withDatabase('winkey')
          .withUsername('winkey')
          .withPassword('winkey')
          .start();
        dbUrl = container.getConnectionUri();
        stopPg = async () => {
          await container.stop();
        };
      } catch {
        return; // Docker unavailable
      }
    }

    pool = new pg.Pool({ connectionString: dbUrl });
    pool.on('error', () => {});
    const migrationsDir = path.join(repoRoot, 'db', 'migrations');
    const client = await pool.connect();
    try {
      const applied = await client.query(
        "SELECT to_regclass('social.subscriptions') IS NOT NULL AS done",
      );
      if (!applied.rows[0].done) {
        for (const f of fs
          .readdirSync(migrationsDir)
          .filter((n) => n.endsWith('.up.sql'))
          .sort()) {
          await client.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
        }
      }
    } finally {
      client.release();
    }

    // Re-runnable against a persistent TEST_DATABASE_URL: drop rows of a previous run first.
    await pool.query(`DELETE FROM auth.users WHERE email LIKE 'p6a-%@example.com'`);
    await pool.query(
      `INSERT INTO auth.users (id, email, handle, display_name, status) VALUES
        ($1, 'p6a-me@example.com', 'p6a_me', 'Tuấn Tôi', 'ACTIVE'),
        ($2, 'p6a-friend@example.com', 'p6a_zfriend', 'Tuấn Bạn', 'ACTIVE'),
        ($3, 'p6a-followed@example.com', 'p6a_yfollowed', 'Anh Tuấn', 'ACTIVE'),
        ($4, 'p6a-stranger@example.com', 'p6a_tuan', 'Người Lạ', 'ACTIVE'),
        ($5, 'p6a-blocker@example.com', 'p6a_blocker', 'Tuấn Chặn', 'ACTIVE'),
        ($6, 'p6a-blocked@example.com', 'p6a_blocked', 'Tuấn Bị Chặn', 'ACTIVE'),
        ($7, 'p6a-suspended@example.com', 'p6a_suspended', 'Tuấn Khoá', 'SUSPENDED')`,
      [me, friend, followed, stranger, blocker, blockedByMe, suspended],
    );
    await pool.query(
      `INSERT INTO social.subscriptions (subscriber_id, channel_id) VALUES ($1, $2), ($2, $1), ($1, $3)`,
      [me, friend, followed],
    );
    await pool.query(
      `INSERT INTO social.blocks (blocker_id, blocked_id) VALUES ($1, $2), ($2, $3)`,
      [blocker, me, blockedByMe],
    );
    // 120 more matches for the cap / cursor checks ("p6a_bulk_…", display name "Bulk …").
    await pool.query(
      `INSERT INTO auth.users (id, email, handle, display_name)
       SELECT gen_random_uuid(), 'p6a-bulk-' || i || '@example.com', 'p6a_bulk_' || lpad(i::text, 3, '0'), 'Bulk ' || i
       FROM generate_series(1, 120) AS i`,
    );

    const env = getEnv({
      DATABASE_URL: dbUrl,
      NODE_ENV: 'test',
      MEDIA_BASE_URL: 'https://media.winkey.vn',
    });
    app = await buildApp({ env, db: getDb(dbUrl, pool).db, rateLimiter: new ValkeyRateLimiter() });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await stopPg?.();
  });

  const search = (query: Record<string, string>, userId?: string) =>
    app!.inject({
      method: 'GET',
      url: `/v1/people/search?${new URLSearchParams(query).toString()}`,
      headers: userId ? { 'x-user-id': userId } : {},
    });

  it('folds diacritics, ranks mutual follows then follows, and hides blocks and the caller', async () => {
    const res = await search({ q: 'tuan' }, me);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validatePeoplePage(body)).toBe(true);
    // Mutual follow first, then a followed user. "p6a_tuan" contains "tuan" only inside its handle (handles match by
    // prefix), the two block relations and the caller are left out, the suspended account has no profile.
    expect(body.items.map((p: any) => p.id)).toEqual([friend, followed]);
    expect(body.next_cursor).toBeNull();
  });

  it('matches handle prefixes case-insensitively and ignores a leading @', async () => {
    const res = await search({ q: '@P6A_TU' }, me);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((p: any) => p.handle)).toEqual(['p6a_tuan']);
  });

  it('anonymous callers see blocked pairs but never suspended accounts', async () => {
    const res = await search({ q: 'Tuấn' });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining([me, friend, followed, blocker, blockedByMe]));
    expect(ids).not.toContain(suspended);
  });

  it('treats LIKE wildcards as literal characters', async () => {
    const res = await search({ q: 'p6a%' }, me);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('pages with an opaque cursor and stops after 100 results', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await search({ q: 'bulk', limit: '20', ...(cursor ? { cursor } : {}) }, me);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(validatePeoplePage(body)).toBe(true);
      seen.push(...body.items.map((p: any) => p.handle));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(PEOPLE_SEARCH_MAX_RESULTS);
    expect(new Set(seen).size).toBe(PEOPLE_SEARCH_MAX_RESULTS);
    expect(seen[0]).toBe('p6a_bulk_001');
  });

  it('rejects bad input with problem+json codes', async () => {
    for (const [query, code] of [
      [{ q: '   ' }, 'INVALID_QUERY'],
      [{ q: '@' }, 'INVALID_QUERY'],
      [{ q: 'x'.repeat(65) }, 'INVALID_QUERY'],
      [{ q: 'tuan', limit: '21' }, 'INVALID_LIMIT'],
      [{ q: 'tuan', cursor: 'not-a-cursor' }, 'INVALID_CURSOR'],
    ] as const) {
      const res = await search(query as Record<string, string>, me);
      expect(res.statusCode).toBe(400);
      expect(validateProblem(res.json())).toBe(true);
      expect(res.json().code).toBe(code);
    }
    // A cursor from another query is rejected too.
    const first = (await search({ q: 'bulk', limit: '5' }, me)).json();
    const res = await search({ q: 'tuan', cursor: first.next_cursor }, me);
    expect(res.json().code).toBe('INVALID_CURSOR');
  });
});
