import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { getDb, registerArrayParsers } from '../../src/db/client.js';
import type { RateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { REFRESH_COOKIE_NAME } from '../../src/crypto/refresh.js';
import { version as uuidVersion } from 'uuid';
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

describe('Real PostgreSQL 17 Integration Tests', () => {
  let pool: pg.Pool | null = null;
  let stopContainer: (() => Promise<void>) | null = null;
  let app: FastifyInstance | null = null;
  let dbUrl: string | null = null;
  let isReady = false;

  beforeEach((ctx) => {
    if (!isReady) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail(
          'Real PostgreSQL 17 / Docker required by WINKEY_REQUIRE_DOCKER=1 but unavailable',
        );
      }
      ctx.skip();
    }
  });

  beforeAll(async () => {
    // 1. Try environment DATABASE_URL or TEST_DATABASE_URL first
    const envUrl =
      process.env.TEST_DATABASE_URL ||
      (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432')
        ? process.env.DATABASE_URL
        : null);
    if (envUrl) {
      try {
        const testPool = new pg.Pool({ connectionString: envUrl, connectionTimeoutMillis: 3000 });
        await testPool.query('SELECT 1');
        pool = testPool;
        dbUrl = envUrl;
        isReady = true;
      } catch {
        // Not reachable
      }
    }

    // 2. Try testcontainers if not already connected
    if (!isReady) {
      try {
        const tc = await import('@testcontainers/postgresql');
        const container = await new tc.PostgreSqlContainer('postgres:17-alpine')
          .withDatabase('winkey')
          .withUsername('winkey')
          .withPassword('winkey')
          .start();

        dbUrl = container.getConnectionUri();
        stopContainer = async () => {
          await container.stop();
        };
        pool = new pg.Pool({ connectionString: dbUrl });
        isReady = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[postgres-real.test.ts] testcontainers failed to start: ${msg}`);
      }
    }

    // 3. Docker requirement gating (like libs/go/testkit)
    if (!isReady || !pool || !dbUrl) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail(
          'Real PostgreSQL 17 / Docker required by WINKEY_REQUIRE_DOCKER=1 but unavailable',
        );
      }
      return;
    }

    // 4. Apply all db/migrations/*.up.sql in order
    const repoRoot = findRepoRoot();
    await applyMigrations(pool, path.join(repoRoot, 'db', 'migrations'));

    // 4b. Register custom enum array parsers so auth.role[] is parsed as string[]
    await registerArrayParsers(pool);

    // 5. Initialize Fastify app with real DB
    const keys = getTestKeys();
    const env = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      DATABASE_URL: dbUrl,
      NODE_ENV: 'test',
      TRUST_PROXY_CIDRS: '10.42.0.0/16,127.0.0.1',
    });

    const { db } = getDb(dbUrl, pool);
    const rateLimiter: RateLimiter = {
      consume: async () => {},
      close: async () => {},
    };

    app = await buildApp({
      env,
      db,
      rateLimiter,
    });
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (pool) {
      await pool.end();
    }
    if (stopContainer) {
      await stopContainer();
    }
  }, 60_000);

  it('register: inserts user, atomic outbox row, and rejects duplicate email/handle with 409', async () => {
    if (!app || !pool) return;

    // 1. Happy path registration
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'alice_real@winkey.vn',
        password: 'Password123!',
        handle: 'alice_real',
        display_name: 'Alice Real',
      },
    });

    expect(regRes.statusCode).toBe(201);
    const body = regRes.json();
    expect(body.user.email).toBe('alice_real@winkey.vn');
    expect(body.user.handle).toBe('alice_real');
    expect(Array.isArray(body.user.roles)).toBe(true);
    expect(body.user.roles).toEqual(['viewer', 'creator']);
    expect(regRes.headers['set-cookie']).toContain(REFRESH_COOKIE_NAME + '=');

    // Verify outbox row written in the SAME transaction
    const outboxRes = await pool.query(
      'SELECT id, event_id, subject, payload, published_at FROM auth.outbox WHERE subject = $1 ORDER BY id DESC LIMIT 1',
      ['user.registered'],
    );
    expect(outboxRes.rows.length).toBe(1);
    const outboxRow = outboxRes.rows[0];
    expect(uuidVersion(outboxRow.event_id)).toBe(7);
    expect(outboxRow.published_at).toBeNull();

    const payload =
      typeof outboxRow.payload === 'string' ? JSON.parse(outboxRow.payload) : outboxRow.payload;
    expect(payload.type).toBe('user.registered');
    expect(payload.producer).toBe('auth-svc');
    expect(payload.data.user_id).toBe(body.user.id);
    expect(payload.data.handle).toBe('alice_real');
    expect(payload.data.method).toBe('password');

    // 2. Real PostgreSQL unique constraint on email -> 409 EMAIL_TAKEN
    const dupEmailRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'alice_real@winkey.vn',
        password: 'Password123!',
        handle: 'alice_different_handle',
        display_name: 'Alice Dup Email',
      },
    });
    expect(dupEmailRes.statusCode).toBe(409);
    expect(dupEmailRes.json().code).toBe('EMAIL_TAKEN');

    // 3. Real PostgreSQL unique constraint on handle -> 409 HANDLE_TAKEN
    const dupHandleRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'bob_real@winkey.vn',
        password: 'Password123!',
        handle: 'alice_real',
        display_name: 'Bob Dup Handle',
      },
    });
    expect(dupHandleRes.statusCode).toBe(409);
    expect(dupHandleRes.json().code).toBe('HANDLE_TAKEN');
  });

  it('login: succeeds with valid password and rejects invalid password', async () => {
    if (!app || !pool) return;

    // Login with valid credentials
    const okRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'alice_real@winkey.vn',
        password: 'Password123!',
      },
    });
    expect(okRes.statusCode).toBe(200);
    const body = okRes.json();
    expect(body.access_token).toBeDefined();
    expect(okRes.headers['set-cookie']).toContain(REFRESH_COOKIE_NAME + '=');

    // Regression check: roles must be an array, NOT a postgres enum string '{viewer,creator}'
    expect(Array.isArray(body.user.roles)).toBe(true);
    expect(body.user.roles).toEqual(['viewer', 'creator']);

    // Regression check: verify forwardAuth works with the access token without 500 TypeError
    const verifyRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/verify',
      headers: {
        authorization: `Bearer ${body.access_token}`,
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.headers['x-user-id']).toBe(body.user.id);
    expect(verifyRes.headers['x-user-roles']).toBe('viewer,creator');

    // Login with wrong password
    const wrongRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'alice_real@winkey.vn',
        password: 'WrongPassword!',
      },
    });
    expect(wrongRes.statusCode).toBe(401);
    expect(wrongRes.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('refresh rotation and reuse detection: family revocation PERSISTS in database', async () => {
    if (!app || !pool) return;

    // 1. Register a dedicated user for refresh rotation test
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'rotation_test@winkey.vn',
        password: 'Password123!',
        handle: 'rotation_test',
        display_name: 'Rotation Test',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const initialCookie = regRes.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME)!.value;

    // 2. Normal rotation: use initial token to get rotated token
    const refresh1Res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: initialCookie },
    });
    expect(refresh1Res.statusCode).toBe(200);
    const childCookie = refresh1Res.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME)!.value;
    expect(childCookie).not.toBe(initialCookie);

    // Verify parent token has rotated_at set in DB, child token is active
    const parentQuery = await pool.query(
      'SELECT id, family_id, rotated_at, revoked_at FROM auth.refresh_tokens WHERE parent_id IS NULL AND user_id = $1',
      [regRes.json().user.id],
    );
    expect(parentQuery.rows.length).toBe(1);
    expect(parentQuery.rows[0].rotated_at).not.toBeNull();
    expect(parentQuery.rows[0].revoked_at).toBeNull();
    const familyId = parentQuery.rows[0].family_id;

    // 3. REUSE DETECTION: Present old rotated initial token again!
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: initialCookie },
    });
    expect(reuseRes.statusCode).toBe(401);
    expect(reuseRes.json().detail).toBe('Refresh token reuse detected');

    // 4. CRITICAL SECURITY ASSERTION: Family revocation is COMMITTED and STAYS revoked!
    // In buggy code where throw was inside trx, Kysely rolled this back so revoked_at was NULL.
    // In fixed code, revoked_at MUST NOT be null!
    const revokedTokensRes = await pool.query(
      'SELECT id, revoked_at FROM auth.refresh_tokens WHERE family_id = $1',
      [familyId],
    );
    expect(revokedTokensRes.rows.length).toBe(2);
    for (const row of revokedTokensRes.rows) {
      expect(row.revoked_at).not.toBeNull();
    }

    // 5. Subsequent request with the child token must now also fail
    const subsequentRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: childCookie },
    });
    expect(subsequentRes.statusCode).toBe(401);
  }, 60_000);

  async function createAdminUser(adminId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b0001') {
    const email = `admin_${adminId.slice(-6)}@winkey.vn`;
    const handle = `admin_${adminId.slice(-6)}`;
    await pool!.query(
      `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
       VALUES ($1, $2, 'dummyhash', $3, 'Admin User', ARRAY['admin', 'viewer']::auth.role[], 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET roles = ARRAY['admin', 'viewer']::auth.role[], status = 'ACTIVE'`,
      [adminId, email, handle],
    );
    return {
      adminId,
      adminHeaders: {
        'x-user-id': adminId,
        'x-user-roles': 'admin,viewer',
      },
    };
  }

  it('admin: role update writes USER_ROLES_CHANGED audit row; identical update writes no audit row', async () => {
    if (!app || !pool) return;
    const { adminHeaders, adminId } = await createAdminUser();

    // 1. Register a test user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'role_test_real@winkey.vn',
        password: 'Password123!',
        handle: 'role_test_real',
        display_name: 'Role Test Real',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const targetId = regRes.json().user.id;

    // 2. Set new roles
    const putRes1 = await app.inject({
      method: 'PUT',
      url: `/v1/admin/users/${targetId}/roles`,
      headers: adminHeaders,
      payload: {
        roles: ['viewer', 'creator', 'moderator'],
      },
    });
    expect(putRes1.statusCode).toBe(200);
    expect(putRes1.json().roles).toEqual(['viewer', 'creator', 'moderator']);

    const auditRes1 = await pool.query(
      'SELECT id, actor_id, action, target_user_id, details FROM auth.audit_log WHERE target_user_id = $1 AND action = $2',
      [targetId, 'USER_ROLES_CHANGED'],
    );
    expect(auditRes1.rows.length).toBe(1);
    expect(auditRes1.rows[0].actor_id).toBe(adminId);
    const details =
      typeof auditRes1.rows[0].details === 'string'
        ? JSON.parse(auditRes1.rows[0].details)
        : auditRes1.rows[0].details;
    expect(details.to).toEqual(['viewer', 'creator', 'moderator']);

    // 3. Set identical roles again -> 200 but NO extra audit row
    const putRes2 = await app.inject({
      method: 'PUT',
      url: `/v1/admin/users/${targetId}/roles`,
      headers: adminHeaders,
      payload: {
        roles: ['viewer', 'creator', 'moderator'],
      },
    });
    expect(putRes2.statusCode).toBe(200);

    const auditRes2 = await pool.query(
      'SELECT id FROM auth.audit_log WHERE target_user_id = $1 AND action = $2',
      [targetId, 'USER_ROLES_CHANGED'],
    );
    expect(auditRes2.rows.length).toBe(1);
  });

  it('admin: user suspension creates exactly 1 audit row, revokes all refresh tokens, login returns 403', async () => {
    if (!app || !pool) return;
    const { adminHeaders, adminId } = await createAdminUser();

    // 1. Register user and log in to obtain refresh tokens
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'suspend_test_real@winkey.vn',
        password: 'Password123!',
        handle: 'suspend_real_user',
        display_name: 'Suspend Real User',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const targetId = regRes.json().user.id;

    // Login once more
    const loginRes1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'suspend_test_real@winkey.vn',
        password: 'Password123!',
      },
    });
    expect(loginRes1.statusCode).toBe(200);

    // Verify user has active refresh tokens
    const beforeTokens = await pool.query(
      'SELECT id, revoked_at FROM auth.refresh_tokens WHERE user_id = $1',
      [targetId],
    );
    expect(beforeTokens.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of beforeTokens.rows) {
      expect(row.revoked_at).toBeNull();
    }

    // 2. Suspend user
    const futureUntil = new Date(Date.now() + 7 * 86400000).toISOString();
    const suspRes = await app.inject({
      method: 'PUT',
      url: `/v1/admin/users/${targetId}/suspension`,
      headers: adminHeaders,
      payload: {
        reason: 'Violated terms of service real test',
        until: futureUntil,
      },
    });
    expect(suspRes.statusCode).toBe(200);
    expect(suspRes.json().status).toBe('SUSPENDED');

    // Exactly 1 audit row
    const auditRes = await pool.query(
      'SELECT id, actor_id, action, target_user_id FROM auth.audit_log WHERE target_user_id = $1 AND action = $2',
      [targetId, 'USER_SUSPENDED'],
    );
    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0].actor_id).toBe(adminId);

    // All refresh tokens have revoked_at IS NOT NULL
    const afterTokens = await pool.query(
      'SELECT id, revoked_at FROM auth.refresh_tokens WHERE user_id = $1',
      [targetId],
    );
    expect(afterTokens.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of afterTokens.rows) {
      expect(row.revoked_at).not.toBeNull();
    }

    // Login returns 403 ACCOUNT_SUSPENDED with until, never internal reason
    const loginRes2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'suspend_test_real@winkey.vn',
        password: 'Password123!',
      },
    });
    expect(loginRes2.statusCode).toBe(403);
    const prob = loginRes2.json();
    expect(prob.code).toBe('ACCOUNT_SUSPENDED');
    expect(prob.detail).toContain(futureUntil);
    expect(prob.detail).not.toContain('Violated terms of service real test');
  });

  it('login: expired suspension auto-lifts to ACTIVE and records audit row with details { expired: true }', async () => {
    if (!app || !pool) return;

    // 1. Register user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'expired_real@winkey.vn',
        password: 'Password123!',
        handle: 'expired_real_user',
        display_name: 'Expired Real User',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const targetId = regRes.json().user.id;

    // 2. Put user into SUSPENDED state with suspended_until 1 hour in the past
    await pool.query(
      `UPDATE auth.users
       SET status = 'SUSPENDED',
           suspended_until = NOW() - INTERVAL '1 hour',
           suspension_reason = 'Temporary 1 hour cooldown'
       WHERE id = $1`,
      [targetId],
    );

    // 3. User logs in with valid password
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'expired_real@winkey.vn',
        password: 'Password123!',
      },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().access_token).toBeDefined();

    // 4. In PostgreSQL, status is now ACTIVE, suspended_until and reason are NULL
    const userRowRes = await pool.query(
      'SELECT status, suspended_until, suspension_reason FROM auth.users WHERE id = $1',
      [targetId],
    );
    expect(userRowRes.rows.length).toBe(1);
    expect(userRowRes.rows[0].status).toBe('ACTIVE');
    expect(userRowRes.rows[0].suspended_until).toBeNull();
    expect(userRowRes.rows[0].suspension_reason).toBeNull();

    // 5. Audit log has USER_UNSUSPENDED with details {"expired": true}
    const auditRes = await pool.query(
      'SELECT id, action, details FROM auth.audit_log WHERE target_user_id = $1 AND action = $2',
      [targetId, 'USER_UNSUSPENDED'],
    );
    expect(auditRes.rows.length).toBe(1);
    const details =
      typeof auditRes.rows[0].details === 'string'
        ? JSON.parse(auditRes.rows[0].details)
        : auditRes.rows[0].details;
    expect(details).toEqual({ expired: true });
  });

  it('admin: unsuspend or suspend on DELETED user returns 409 conflict and user remains DELETED', async () => {
    if (!app || !pool) return;
    const { adminHeaders } = await createAdminUser();

    // 1. Register user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'deleted_target_real@winkey.vn',
        password: 'Password123!',
        handle: 'deleted_target_real',
        display_name: 'Deleted Target Real',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const targetId = regRes.json().user.id;

    // Mark user DELETED directly in PostgreSQL
    await pool.query("UPDATE auth.users SET status = 'DELETED' WHERE id = $1", [targetId]);

    // 2. Unsuspend must return 409 conflict
    const unsuspRes = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${targetId}/suspension`,
      headers: adminHeaders,
    });
    expect(unsuspRes.statusCode).toBe(409);
    expect(unsuspRes.json().detail).toContain('User is deleted');

    // 3. User remains DELETED in DB
    const check1 = await pool.query('SELECT status FROM auth.users WHERE id = $1', [targetId]);
    expect(check1.rows[0].status).toBe('DELETED');

    // 4. Suspend must return 409 conflict
    const suspRes = await app.inject({
      method: 'PUT',
      url: `/v1/admin/users/${targetId}/suspension`,
      headers: adminHeaders,
      payload: {
        reason: 'Cannot suspend deleted user',
      },
    });
    expect(suspRes.statusCode).toBe(409);
    expect(suspRes.json().detail).toContain('User is deleted');

    // 5. User still remains DELETED
    const check2 = await pool.query('SELECT status FROM auth.users WHERE id = $1', [targetId]);
    expect(check2.rows[0].status).toBe('DELETED');
  });

  it('admin: adminListUsers q search matches display_name via pg_trgm and handle prefix', async () => {
    if (!app || !pool) return;
    const { adminHeaders } = await createAdminUser();

    // 1. Register users with distinct names and handles
    const u1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'trgm_alice@winkey.vn',
        password: 'Password123!',
        handle: 'trgm_alice',
        display_name: 'Alice Trigram Searcher',
      },
    });
    expect(u1.statusCode).toBe(201);
    const aliceId = u1.json().user.id;

    const u2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'trgm_bob@winkey.vn',
        password: 'Password123!',
        handle: 'trgm_bob',
        display_name: 'Bob Video Producer',
      },
    });
    expect(u2.statusCode).toBe(201);
    const bobId = u2.json().user.id;

    // 2. Search by display_name similarity via pg_trgm % operator
    const searchRes1 = await app.inject({
      method: 'GET',
      url: '/v1/admin/users?q=Searcher',
      headers: adminHeaders,
    });
    expect(searchRes1.statusCode).toBe(200);
    const items1 = searchRes1.json().items as Array<{ id: string }>;
    expect(items1.some((u) => u.id === aliceId)).toBe(true);
    expect(items1.some((u) => u.id === bobId)).toBe(false);

    // 3. Search by handle prefix
    const searchRes2 = await app.inject({
      method: 'GET',
      url: '/v1/admin/users?q=trgm_b',
      headers: adminHeaders,
    });
    expect(searchRes2.statusCode).toBe(200);
    const items2 = searchRes2.json().items as Array<{ id: string }>;
    expect(items2.some((u) => u.id === bobId)).toBe(true);
    expect(items2.some((u) => u.id === aliceId)).toBe(false);

    // 4. Wildcard escaping: search for literal '%' does not error or match unintended rows
    const searchRes3 = await app.inject({
      method: 'GET',
      url: '/v1/admin/users?q=%25',
      headers: adminHeaders,
    });
    expect(searchRes3.statusCode).toBe(200);
  });
});
