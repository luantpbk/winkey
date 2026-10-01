import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parse as parseYaml } from 'yaml';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { getDb, registerArrayParsers } from '../../src/db/client.js';
import type { RateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { REFRESH_COOKIE_NAME } from '../../src/crypto/refresh.js';
import { v7 as uuidv7, version as uuidVersion } from 'uuid';
import { issueAccessToken } from '../../src/crypto/jwt.js';
import { hashPassword } from '../../src/crypto/passwords.js';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { authRegistry } from '../../src/revocation/revocation.js';
import type { Counter } from '@winkey/metrics';
import { MailQueueWorker } from '../../src/mail/worker.js';
import { NodeMailerSender } from '../../src/mail/mailer.js';
import { generateEmailToken } from '../../src/tokens/email-tokens.js';

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
  let valkeyContainerStop: (() => Promise<void>) | null = null;
  let mailpitContainerStop: (() => Promise<void>) | null = null;
  let mailpitApiUrl: string | null = null;
  let mailWorker: MailQueueWorker | null = null;
  let redisClient: Redis | null = null;
  let app: FastifyInstance | null = null;
  let dbUrl: string | null = null;
  let isReady = false;
  let testEnv: ReturnType<typeof getEnv> | null = null;
  let validateProblem: ValidateFunction;
  let validateTokenResponse: ValidateFunction;
  let validateUser: ValidateFunction;

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

    // 2b. Start Valkey / Redis container if available
    let valkeyUrl = process.env.TEST_VALKEY_URL || process.env.VALKEY_URL || null;
    if (!valkeyUrl || valkeyUrl.includes('localhost:6379')) {
      try {
        const { GenericContainer } = await import('testcontainers');
        const valkeyContainer = await new GenericContainer('redis:7-alpine')
          .withExposedPorts(6379)
          .start();
        const mappedPort = valkeyContainer.getMappedPort(6379);
        const host = valkeyContainer.getHost();
        valkeyUrl = `redis://${host}:${mappedPort}`;
        valkeyContainerStop = async () => {
          await valkeyContainer.stop();
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[postgres-real.test.ts] valkey testcontainer failed to start: ${msg}`);
      }
    }

    if (valkeyUrl) {
      redisClient = new Redis(valkeyUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
    }

    // 2c. Start Mailpit container if available (task A6)
    let smtpUrl = process.env.TEST_SMTP_URL || process.env.SMTP_URL || null;
    if (!smtpUrl) {
      try {
        const { GenericContainer } = await import('testcontainers');
        const mailpitContainer = await new GenericContainer('axllent/mailpit:latest')
          .withExposedPorts(1025, 8025)
          .start();
        const smtpPort = mailpitContainer.getMappedPort(1025);
        const apiPort = mailpitContainer.getMappedPort(8025);
        const host = mailpitContainer.getHost();
        smtpUrl = `smtp://${host}:${smtpPort}`;
        mailpitApiUrl = `http://${host}:${apiPort}`;
        mailpitContainerStop = async () => {
          await mailpitContainer.stop();
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[postgres-real.test.ts] mailpit testcontainer failed to start: ${msg}`);
      }
    }

    // 3. Docker requirement gating (like libs/go/testkit)
    if (!isReady || !pool || !dbUrl || !redisClient) {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail(
          'Real PostgreSQL 17 / Valkey / Docker required by WINKEY_REQUIRE_DOCKER=1 but unavailable',
        );
      }
      isReady = false;
      return;
    }

    // 4. Apply all db/migrations/*.up.sql in order
    const repoRoot = findRepoRoot();
    await applyMigrations(pool, path.join(repoRoot, 'db', 'migrations'));

    // 4b. Register custom enum array parsers so auth.role[] is parsed as string[]
    await registerArrayParsers(pool);

    // 4c. Setup Ajv OpenAPI contract validation
    try {
      const authYamlPath = path.resolve(repoRoot, 'contracts/openapi/auth.v1.yaml');
      const commonYamlPath = path.resolve(repoRoot, 'contracts/openapi/common.yaml');
      const authSpec = parseYaml(fs.readFileSync(authYamlPath, 'utf8'));
      const commonSpec = parseYaml(fs.readFileSync(commonYamlPath, 'utf8'));
      commonSpec.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
      authSpec.$id = 'https://winkey.vn/contracts/openapi/auth.v1.yaml';
      const ajv = new Ajv({ strict: false, allErrors: true });
      (addFormats as unknown as (a: unknown) => void)(ajv);
      ajv.addSchema(commonSpec);
      ajv.addSchema(authSpec);
      validateProblem = ajv.getSchema(
        'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/Problem',
      )!;
      validateTokenResponse = ajv.getSchema(
        'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/TokenResponse',
      )!;
      validateUser = ajv.getSchema(
        'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/User',
      )!;
    } catch (ajvErr) {
      console.warn('[postgres-real.test.ts] Ajv setup error:', ajvErr);
    }

    // 5. Initialize Fastify app with real DB, real Valkey, and Mailpit SMTP
    const keys = getTestKeys();
    const env = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      DATABASE_URL: dbUrl,
      VALKEY_URL: valkeyUrl ?? undefined,
      MAIL_TRANSPORT: smtpUrl ? 'smtp' : 'log',
      SMTP_URL: smtpUrl ?? undefined,
      MAIL_FROM: 'Winkey <no-reply@winkey.vn>',
      NODE_ENV: 'test',
      TRUST_PROXY_CIDRS: '10.42.0.0/16,127.0.0.1',
    });
    testEnv = env;

    const { db } = getDb(dbUrl, pool);
    const rateLimiter: RateLimiter = {
      consume: async () => {},
      close: async () => {},
    };

    app = await buildApp({
      env,
      db,
      rateLimiter,
      redis: redisClient,
    });

    const mailer = new NodeMailerSender(env);
    mailWorker = new MailQueueWorker({ db, mailer });
  }, 120_000);

  afterAll(async () => {
    if (mailWorker) {
      await mailWorker.stop();
    }
    if (app) {
      await app.close();
    }
    if (redisClient) {
      await redisClient.quit().catch(() => {});
    }
    if (pool) {
      await pool.end();
    }
    if (stopContainer) {
      await stopContainer();
    }
    if (valkeyContainerStop) {
      await valkeyContainerStop();
    }
    if (mailpitContainerStop) {
      await mailpitContainerStop();
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
    expect(verifyRes.statusCode).toBe(204);
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
    const initialCookie = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

    // 2. Normal rotation: use initial token to get rotated token
    const refresh1Res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: initialCookie },
    });
    expect(refresh1Res.statusCode).toBe(200);
    const childCookie = refresh1Res.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;
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

  it('Task A3: updateMe reflects handle change in auth.public_profiles and rejects case-variant collision with 409', async () => {
    if (!app || !pool) return;

    // 1. Register User A and User B
    const regA = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'user_pga@winkey.vn',
        password: 'Password123!',
        handle: 'user_pga',
        display_name: 'User PG A',
      },
    });
    expect(regA.statusCode).toBe(201);
    const tokenA = regA.json().access_token;
    const userIdA = regA.json().user.id;

    const regB = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'user_pgb@winkey.vn',
        password: 'Password123!',
        handle: 'user_pgb',
        display_name: 'User PG B',
      },
    });
    expect(regB.statusCode).toBe(201);
    const tokenB = regB.json().access_token;

    // 2. User A updates handle and display name
    const updateRes = await app.inject({
      method: 'PATCH',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        handle: 'user_pga_renamed',
        display_name: 'User PG A Renamed',
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().handle).toBe('user_pga_renamed');
    expect(updateRes.json().display_name).toBe('User PG A Renamed');
    expect(updateRes.json().has_password).toBe(true);

    // 3. Verify handle change is immediately visible in auth.public_profiles view
    const viewRes = await pool.query(
      'SELECT handle, display_name FROM auth.public_profiles WHERE id = $1',
      [userIdA],
    );
    expect(viewRes.rows.length).toBe(1);
    expect(viewRes.rows[0].handle).toBe('user_pga_renamed');
    expect(viewRes.rows[0].display_name).toBe('User PG A Renamed');

    // Old handle no longer resolves
    const oldViewRes = await pool.query('SELECT id FROM auth.public_profiles WHERE handle = $1', [
      'user_pga',
    ]);
    expect(oldViewRes.rows.length).toBe(0);

    // 4. User B tries to change handle to case-variant of User A's new handle
    const conflictRes = await app.inject({
      method: 'PATCH',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        handle: 'USER_PGA_RENAMED',
      },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json().code).toBe('HANDLE_TAKEN');
  });

  it('Task A3: changePassword updates credentials, revokes other device sessions, and sets first password for OAuth account', async () => {
    if (!app || !pool || !testEnv) return;

    // 1. Register user (Device 1)
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'chgpwd_real@winkey.vn',
        password: 'InitialPassword123!',
        handle: 'chgpwd_real',
        display_name: 'Change Pwd Real',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const dev1Cookie = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;
    const dev1Token = regRes.json().access_token;

    // 2. Login on Device 2
    const loginDev2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'chgpwd_real@winkey.vn',
        password: 'InitialPassword123!',
      },
    });
    expect(loginDev2.statusCode).toBe(200);
    const dev2Cookie = loginDev2.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

    // 3. Change password from Device 1 with current cookie
    const chgRes = await app.inject({
      method: 'PUT',
      url: '/v1/auth/me/password',
      headers: { authorization: `Bearer ${dev1Token}` },
      cookies: { [REFRESH_COOKIE_NAME]: dev1Cookie },
      payload: {
        current_password: 'InitialPassword123!',
        new_password: 'NewSuperPassword123!',
      },
    });
    expect(chgRes.statusCode).toBe(204);

    // 4. Old password fails login, new password works
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'chgpwd_real@winkey.vn', password: 'InitialPassword123!' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'chgpwd_real@winkey.vn', password: 'NewSuperPassword123!' },
    });
    expect(newLogin.statusCode).toBe(200);

    // 5. Device 2 refresh token is revoked (401), Device 1 refresh token stays valid (200)
    const dev2Refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: dev2Cookie },
    });
    expect(dev2Refresh.statusCode).toBe(401);

    const dev1Refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: dev1Cookie },
    });
    expect(dev1Refresh.statusCode).toBe(200);

    // 6. OAuth-only user (insert user with password_hash NULL and oauth_identities row)
    const oauthUserId = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, handle, display_name, password_hash, status)
       VALUES ($1, $2, $3, $4, NULL, 'ACTIVE')`,
      [oauthUserId, 'oauth_only_real@winkey.vn', 'oauth_only_real', 'OAuth Only Real'],
    );
    await pool.query(
      `INSERT INTO auth.oauth_identities (provider, subject, user_id, email)
       VALUES ('google', 'goog-sub-99999', $1, 'oauth_only_real@winkey.vn')`,
      [oauthUserId],
    );

    const { token: oauthAccessToken } = await issueAccessToken(
      { id: oauthUserId, roles: ['viewer', 'creator'] },
      uuidv7(),
      testEnv,
    );

    const meBefore = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${oauthAccessToken}` },
    });
    expect(meBefore.statusCode).toBe(200);
    expect(meBefore.json().has_password).toBe(false);

    // Set first password
    const setPwdRes = await app.inject({
      method: 'PUT',
      url: '/v1/auth/me/password',
      headers: { authorization: `Bearer ${oauthAccessToken}` },
      payload: {
        new_password: 'OAuthUserPassword123!',
      },
    });
    expect(setPwdRes.statusCode).toBe(204);

    // Can now log in with email and new password
    const oauthLoginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'oauth_only_real@winkey.vn',
        password: 'OAuthUserPassword123!',
      },
    });
    expect(oauthLoginRes.statusCode).toBe(200);
  });

  it('Task A3: deleteMe scrubs row, deletes oauth_identities, revokes tokens, clears cookie, allows re-registration, and enforces LAST_ADMIN', async () => {
    if (!app || !pool || !testEnv) return;

    // 1. Register a user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'to_be_deleted@winkey.vn',
        password: 'Password123!',
        handle: 'to_be_deleted',
        display_name: 'To Be Deleted',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const delCookie = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;
    const delToken = regRes.json().access_token;
    const delUserId = regRes.json().user.id;

    // Link an oauth identity for this user
    await pool.query(
      `INSERT INTO auth.oauth_identities (provider, subject, user_id, email)
       VALUES ('google', 'goog-del-target', $1, 'to_be_deleted@winkey.vn')`,
      [delUserId],
    );

    // 2. Delete account with case-insensitive confirmation handle
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${delToken}` },
      payload: {
        confirm_handle: 'TO_BE_DELETED',
        password: 'Password123!',
      },
    });
    expect(delRes.statusCode).toBe(204);
    expect(delRes.headers['set-cookie'] as string).toContain('Max-Age=0');

    // 3. Verify PostgreSQL row in auth.users
    const userDbRes = await pool.query('SELECT * FROM auth.users WHERE id = $1', [delUserId]);
    expect(userDbRes.rows.length).toBe(1);
    const row = userDbRes.rows[0];
    expect(row.status).toBe('DELETED');
    expect(row.email).toBe(`deleted+${delUserId}@invalid.winkey.vn`);
    const hex = delUserId.replace(/-/g, '');
    expect(row.handle).toBe(`d_${hex.slice(0, 28)}`);
    expect(row.handle.length).toBe(30);
    expect(row.display_name).toBe('Deleted user');
    expect(row.password_hash).toBeNull();
    expect(row.email_verified_at).toBeNull();
    expect(row.avatar_key).toBeNull();
    expect(row.suspended_until).toBeNull();
    expect(row.suspension_reason).toBeNull();

    // 4. Verify auth.public_profiles does NOT include deleted user
    const viewCheck = await pool.query('SELECT id FROM auth.public_profiles WHERE id = $1', [
      delUserId,
    ]);
    expect(viewCheck.rows.length).toBe(0);

    // 5. Verify auth.oauth_identities row was removed
    const oauthCheck = await pool.query(
      'SELECT user_id FROM auth.oauth_identities WHERE user_id = $1',
      [delUserId],
    );
    expect(oauthCheck.rows.length).toBe(0);

    // 6. Refresh token is revoked
    const refreshCheck = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: delCookie },
    });
    expect(refreshCheck.statusCode).toBe(401);

    // 7. Login with old email fails
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'to_be_deleted@winkey.vn',
        password: 'Password123!',
      },
    });
    expect(oldLogin.statusCode).toBe(401);

    // 8. Re-registration with the same email and handle succeeds
    const reReg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'to_be_deleted@winkey.vn',
        password: 'BrandNewPassword123!',
        handle: 'to_be_deleted',
        display_name: 'Re-registered User',
      },
    });
    expect(reReg.statusCode).toBe(201);
    expect(reReg.json().user.handle).toBe('to_be_deleted');

    // 9. LAST_ADMIN safeguard: sole admin cannot delete self
    const soleAdminId = uuidv7();
    // Demote or delete any existing active admin accounts first so this is the only admin
    await pool.query(
      "UPDATE auth.users SET roles = ARRAY['viewer']::auth.role[] WHERE 'admin' = ANY(roles) AND id != $1",
      [soleAdminId],
    );
    const adminHash = await hashPassword('AdminPass123!');
    await pool.query(
      `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
       VALUES ($1, 'sole_admin_pg@winkey.vn', $2, 'sole_admin_pg', 'Sole Admin', ARRAY['admin', 'viewer']::auth.role[], 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET roles = ARRAY['admin', 'viewer']::auth.role[], password_hash = $2, status = 'ACTIVE'`,
      [soleAdminId, adminHash],
    );
    const { token: soleAdminToken } = await issueAccessToken(
      { id: soleAdminId, roles: ['admin', 'viewer'] },
      uuidv7(),
      testEnv,
    );

    // Wrong password returns 403 INVALID_CREDENTIALS before 409
    const wrongPwdRes = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${soleAdminToken}` },
      payload: {
        confirm_handle: 'sole_admin_pg',
        password: 'WrongPassword!',
      },
    });
    expect(wrongPwdRes.statusCode).toBe(403);
    expect(wrongPwdRes.json().code).toBe('INVALID_CREDENTIALS');

    // Correct password on sole admin returns 409 LAST_ADMIN
    const lastAdminRes = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${soleAdminToken}` },
      payload: {
        confirm_handle: 'sole_admin_pg',
        password: 'AdminPass123!',
      },
    });
    expect(lastAdminRes.statusCode).toBe(409);
    expect(lastAdminRes.json().code).toBe('LAST_ADMIN');
  });

  describe('Task A4: Immediate Session & User Revocation (ADR-019)', () => {
    // 1. login -> verify 204 -> logout -> verify with the SAME access token 401
    it('login -> verify 204 -> logout -> verify with the SAME access token returns 401', async () => {
      if (!app || !pool || !testEnv) return;

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'a4_logout_user@winkey.vn',
          password: 'Password123!',
          handle: 'a4_logout_user',
          display_name: 'Logout User',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const accessToken = regRes.json().access_token;
      const rtCookie = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

      // Verify token is valid before logout
      const v1 = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(v1.statusCode).toBe(204);
      expect(v1.headers['x-user-id']).toBe(regRes.json().user.id);

      // Logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        cookies: { [REFRESH_COOKIE_NAME]: rtCookie },
      });
      expect(logoutRes.statusCode).toBe(204);

      // Verify with the SAME access token -> immediate 401
      const v2 = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(v2.statusCode).toBe(401);
      expect(v2.json().code).toBe('UNAUTHORIZED');
    });

    // 2. admin suspends user -> the user's still-valid access token gets 401 on verify immediately
    it('admin suspends user -> still-valid access token gets 401 on verify immediately', async () => {
      if (!app || !pool || !testEnv) return;

      const adminId = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES ($1, 'admin_suspender@winkey.vn', 'hash', 'admin_suspender', 'Admin Suspender', ARRAY['admin', 'viewer']::auth.role[], 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [adminId],
      );

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'to_suspend@winkey.vn',
          password: 'Password123!',
          handle: 'to_suspend',
          display_name: 'To Suspend',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const userToken = regRes.json().access_token;
      const userId = regRes.json().user.id;

      // Verify user's token works initially
      const v1 = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(v1.statusCode).toBe(204);

      // Admin suspends user
      const suspendRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${userId}/suspension`,
        headers: {
          'x-user-id': adminId,
          'x-user-roles': 'admin,viewer',
        },
        payload: {
          reason: 'Terms of service violation',
        },
      });
      expect(suspendRes.statusCode).toBe(200);

      // User's still-valid access token gets 401 immediately
      const v2 = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(v2.statusCode).toBe(401);
      expect(v2.json().code).toBe('UNAUTHORIZED');
    });

    // 3. admin changes roles -> old token 401 -> refresh -> new token 204 with the NEW X-User-Roles
    it('admin changes roles -> old token 401 -> refresh -> new token 204 with the new roles', async () => {
      if (!app || !pool || !testEnv) return;

      const adminId = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES ($1, 'admin_role_changer@winkey.vn', 'hash', 'admin_role_changer', 'Admin Roles', ARRAY['admin', 'viewer']::auth.role[], 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [adminId],
      );

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'role_change_user@winkey.vn',
          password: 'Password123!',
          handle: 'role_change_user',
          display_name: 'Role Change User',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const oldToken = regRes.json().access_token;
      const rtCookie1 = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;
      const userId = regRes.json().user.id;

      // Old token verified with initial roles (viewer,creator)
      const v1 = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${oldToken}` },
      });
      expect(v1.statusCode).toBe(204);
      expect(v1.headers['x-user-roles']).toBe('viewer,creator');

      // Admin changes roles to viewer only (demote creator)
      const roleRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${userId}/roles`,
        headers: {
          'x-user-id': adminId,
          'x-user-roles': 'admin,viewer',
        },
        payload: {
          roles: ['viewer'],
        },
      });
      expect(roleRes.statusCode).toBe(200);

      // Old token gets 401 immediately
      const vOld = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${oldToken}` },
      });
      expect(vOld.statusCode).toBe(401);

      // Per ADR-019: tokens issued in the same second as revocation have iat <= cutoff;
      // wait until the next second so the refreshed token has iat > cutoff
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // User calls refresh to get new access token
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: rtCookie1 },
      });
      expect(refreshRes.statusCode).toBe(200);
      const newToken = refreshRes.json().access_token;
      expect(refreshRes.json().user.roles).toEqual(['viewer']);

      // New token gets 204 with updated roles
      const vNew = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${newToken}` },
      });
      expect(vNew.statusCode).toBe(204);
      expect(vNew.headers['x-user-roles']).toBe('viewer');
    });

    // 4. changePassword -> the other device's access token 401, the current device's token still 204
    it('changePassword -> other device access token gets 401, current device token returns 204', async () => {
      if (!app || !pool || !testEnv) return;

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'multi_device@winkey.vn',
          password: 'OldPassword123!',
          handle: 'multi_device',
          display_name: 'Multi Device',
        },
      });
      expect(regRes.statusCode).toBe(201);

      // Device 1 login
      const dev1Login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'multi_device@winkey.vn',
          password: 'OldPassword123!',
        },
      });
      expect(dev1Login.statusCode).toBe(200);
      const tokenDev1 = dev1Login.json().access_token;

      // Device 2 login
      const dev2Login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'multi_device@winkey.vn',
          password: 'OldPassword123!',
        },
      });
      expect(dev2Login.statusCode).toBe(200);
      const tokenDev2 = dev2Login.json().access_token;

      // Both tokens are valid before changePassword
      const vDev1Before = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${tokenDev1}` },
      });
      expect(vDev1Before.statusCode).toBe(204);

      const vDev2Before = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${tokenDev2}` },
      });
      expect(vDev2Before.statusCode).toBe(204);

      // Device 1 changes password WITHOUT the wk_rt cookie (API client / no cookie)
      const changeRes = await app.inject({
        method: 'PUT',
        url: '/v1/auth/me/password',
        headers: { authorization: `Bearer ${tokenDev1}` },
        payload: {
          current_password: 'OldPassword123!',
          new_password: 'NewPassword123!',
        },
      });
      expect(changeRes.statusCode).toBe(204);

      // Device 2 (other device) token gets 401 immediately
      const vDev2After = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${tokenDev2}` },
      });
      expect(vDev2After.statusCode).toBe(401);

      // Device 1 (current device) token remains valid (204)
      const vDev1After = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${tokenDev1}` },
      });
      expect(vDev1After.statusCode).toBe(204);

      // Device 2 refresh token is revoked
      const rtDev2 = dev2Login.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;
      const dev2Refresh = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: rtDev2 },
      });
      expect(dev2Refresh.statusCode).toBe(401);

      // Device 1 refresh token remains valid
      const rtDev1 = dev1Login.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;
      const dev1Refresh = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: rtDev1 },
      });
      expect(dev1Refresh.statusCode).toBe(200);
    });

    // 5. deleteMe -> token 401; refresh reuse -> the family's access token 401
    it('deleteMe -> token 401; refresh reuse -> the entire family access token 401', async () => {
      if (!app || !pool || !testEnv) return;

      // Part A: deleteMe -> token 401
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'del_me_revoked@winkey.vn',
          password: 'Password123!',
          handle: 'del_me_revoked',
          display_name: 'Del Me Revoked',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const delToken = regRes.json().access_token;

      const vBefore = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${delToken}` },
      });
      expect(vBefore.statusCode).toBe(204);

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${delToken}` },
        payload: {
          confirm_handle: 'del_me_revoked',
          password: 'Password123!',
        },
      });
      expect(delRes.statusCode).toBe(204);

      const vAfter = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${delToken}` },
      });
      expect(vAfter.statusCode).toBe(401);

      // Part B: refresh reuse -> the family's access token 401
      const regRes2 = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'reuse_victim@winkey.vn',
          password: 'Password123!',
          handle: 'reuse_victim',
          display_name: 'Reuse Victim',
        },
      });
      expect(regRes2.statusCode).toBe(201);
      const rt1 = regRes2.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

      // Legitimate refresh rotates rt1 -> rt2
      const refreshLegit = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: rt1 },
      });
      expect(refreshLegit.statusCode).toBe(200);
      const tokenLegit = refreshLegit.json().access_token;

      // Verify tokenLegit is valid before reuse attack
      const vLegitBefore = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${tokenLegit}` },
      });
      expect(vLegitBefore.statusCode).toBe(204);

      // Attacker uses old rt1 -> triggers reuse detection
      const reuseAttack = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: rt1 },
      });
      expect(reuseAttack.statusCode).toBe(401);

      // Entire family is now revoked -> tokenLegit gets 401 immediately
      const vLegitAfter = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${tokenLegit}` },
      });
      expect(vLegitAfter.statusCode).toBe(401);
    });

    // 6. Valkey stopped (or client pointed at a closed port) -> verify still 204 for a valid token and the error metric increments
    it('Valkey unreachable -> verify still 204 (fail-open) and error metric increments', async () => {
      if (!app || !pool || !testEnv) return;

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'fail_open_user@winkey.vn',
          password: 'Password123!',
          handle: 'fail_open_user',
          display_name: 'Fail Open User',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const validToken = regRes.json().access_token;
      const validUserId = regRes.json().user.id;

      // Create an app instance pointing to an unreachable Valkey port
      const brokenRedis = new Redis('redis://127.0.0.1:63799', {
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        connectTimeout: 50,
        retryStrategy: () => null,
      });
      brokenRedis.on('error', () => {}); // swallow connection error events

      const failOpenApp = await buildApp({
        env: testEnv,
        db: getDb(dbUrl!, pool).db,
        rateLimiter: { consume: async () => {}, close: async () => {} },
        redis: brokenRedis,
      });

      try {
        const initialMetric = await (
          authRegistry.getSingleMetric('auth_verify_revocation_check_total') as Counter<string>
        )?.get();
        const initialErrorCount =
          initialMetric?.values.find((v) => v.labels.result === 'error')?.value ?? 0;

        const verifyRes = await failOpenApp.inject({
          method: 'GET',
          url: '/v1/auth/verify',
          headers: { authorization: `Bearer ${validToken}` },
        });

        // 204 No Content with identity headers (fail-open)
        expect(verifyRes.statusCode).toBe(204);
        expect(verifyRes.headers['x-user-id']).toBe(validUserId);
        expect(verifyRes.headers['x-user-roles']).toBe('viewer,creator');

        const afterMetric = await (
          authRegistry.getSingleMetric('auth_verify_revocation_check_total') as Counter<string>
        )?.get();
        const afterErrorCount =
          afterMetric?.values.find((v) => v.labels.result === 'error')?.value ?? 0;
        expect(afterErrorCount).toBeGreaterThan(initialErrorCount);
      } finally {
        await failOpenApp.close();
        await brokenRedis.quit().catch(() => {});
      }
    });
  });

  describe('Task A6: Password Reset & Email Verification Integration (DoD)', () => {
    async function getMailpitMessages(): Promise<
      Array<{ ID: string; To: Array<{ Address: string }> }>
    > {
      if (!mailpitApiUrl) return [];
      const res = await fetch(`${mailpitApiUrl}/api/v1/messages`);
      const data = (await res.json()) as {
        messages?: Array<{ ID: string; To: Array<{ Address: string }> }>;
      };
      return data.messages || [];
    }

    async function getMailpitMessageDetail(
      id: string,
    ): Promise<{ Text?: string; HTML?: string } | null> {
      if (!mailpitApiUrl) return null;
      const res = await fetch(`${mailpitApiUrl}/api/v1/message/${id}`);
      return (await res.json()) as { Text?: string; HTML?: string };
    }

    async function clearMailpitMessages(): Promise<void> {
      if (!mailpitApiUrl) return;
      await fetch(`${mailpitApiUrl}/api/v1/messages`, { method: 'DELETE' });
    }

    function extractTokenFromMail(content: string): string {
      const match = content.match(/token=([A-Za-z0-9_-]{43})/);
      if (!match) throw new Error(`Token not found in email content: ${content}`);
      return match[1];
    }

    // DoD Case 1: register -> Mailpit inbox has the verify mail -> verifyEmail -> getMe.email_verified = true
    it('DoD 1: register -> Mailpit inbox has verify mail -> verifyEmail -> getMe.email_verified = true', async () => {
      if (!app || !pool || !mailWorker) return;

      await clearMailpitMessages();

      // 1. Register new user
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        headers: {
          'accept-language': 'vi-VN,vi;q=0.9',
        },
        payload: {
          email: 'dod1_user@winkey.vn',
          password: 'Password123!',
          handle: 'dod1_user',
          display_name: 'DoD 1 User',
        },
      });

      expect(regRes.statusCode).toBe(201);
      const regBody = regRes.json();
      if (validateTokenResponse) {
        expect(validateTokenResponse(regBody)).toBe(true);
      }
      const accessToken = regBody.access_token;
      expect(regBody.user.email_verified).toBe(false);

      // 2. Background worker delivers email from queue to Mailpit
      const sentCount = await mailWorker.processBatchOnce();
      expect(sentCount).toBeGreaterThanOrEqual(1);

      // 3. Inspect Mailpit inbox
      const messages = await getMailpitMessages();
      const verifyMsg = messages.find((m) =>
        m.To.some((to) => to.Address.toLowerCase() === 'dod1_user@winkey.vn'),
      );
      expect(verifyMsg).toBeDefined();

      const detail = await getMailpitMessageDetail(verifyMsg!.ID);
      expect(detail).not.toBeNull();
      const token = extractTokenFromMail(detail!.Text || detail!.HTML || '');
      expect(token).toHaveLength(43);

      // 4. verifyEmail
      const verifyRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/email/verify',
        payload: { token },
      });
      expect(verifyRes.statusCode).toBe(204);

      // 5. getMe reflects verified email
      const meRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(meRes.statusCode).toBe(200);
      const meBody = meRes.json();
      if (validateUser) {
        expect(validateUser(meBody)).toBe(true);
      }
      expect(meBody.email_verified).toBe(true);
    });

    // DoD Case 2: Forgot password for an unknown email: 202 and no mail
    it('DoD 2: Forgot password for an unknown email: 202 and no mail', async () => {
      if (!app || !pool || !mailWorker) return;

      await clearMailpitMessages();

      const forgotRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        payload: {
          email: 'unknown_ghost_user@winkey.vn',
          locale: 'en',
        },
      });

      expect(forgotRes.statusCode).toBe(202);
      expect(forgotRes.body).toBe('');

      await mailWorker.processBatchOnce();

      const messages = await getMailpitMessages();
      expect(messages).toHaveLength(0);
    });

    // DoD Case 3: Forgot -> reset: the old refresh cookie fails, the old access token is rejected by verify within ADR-019 window, login works with new password, and PASSWORD_CHANGED mail arrives
    it('DoD 3: Forgot -> reset: old cookie fails, old access token rejected by verify within ADR-019 window, login works, PASSWORD_CHANGED mail arrives', async () => {
      if (!app || !pool || !mailWorker) return;

      await clearMailpitMessages();

      // 1. Register user
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'dod3_user@winkey.vn',
          password: 'OldPassword123!',
          handle: 'dod3_user',
          display_name: 'DoD 3 User',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const oldAccessToken = regRes.json().access_token;
      const oldCookies = regRes.cookies;
      const oldRefreshCookie = oldCookies.find((c) => c.name === REFRESH_COOKIE_NAME)?.value;
      expect(oldRefreshCookie).toBeDefined();

      // Drain the verify registration email
      await mailWorker.processBatchOnce();
      await clearMailpitMessages();

      // 2. Access token is initially valid at verify
      const initialVerify = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${oldAccessToken}` },
      });
      expect(initialVerify.statusCode).toBe(204);

      // 3. Request password reset
      const forgotRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        payload: {
          email: 'dod3_user@winkey.vn',
          locale: 'en',
        },
      });
      expect(forgotRes.statusCode).toBe(202);

      // 4. Mail delivery
      await mailWorker.processBatchOnce();
      const messages = await getMailpitMessages();
      const resetMail = messages.find((m) =>
        m.To.some((to) => to.Address.toLowerCase() === 'dod3_user@winkey.vn'),
      );
      expect(resetMail).toBeDefined();

      const detail = await getMailpitMessageDetail(resetMail!.ID);
      const resetToken = extractTokenFromMail(detail!.Text || detail!.HTML || '');
      expect(resetToken).toHaveLength(43);

      // Clear mailbox before reset
      await clearMailpitMessages();

      // 5. Reset password
      const resetRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        headers: { 'accept-language': 'en' },
        payload: {
          token: resetToken,
          new_password: 'NewBrandPassword123!',
        },
      });
      expect(resetRes.statusCode).toBe(204);

      // 6. Old refresh cookie is rejected (401)
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: {
          cookie: `${REFRESH_COOKIE_NAME}=${oldRefreshCookie}`,
        },
      });
      expect(refreshRes.statusCode).toBe(401);
      if (validateProblem) {
        expect(validateProblem(refreshRes.json())).toBe(true);
      }

      // 7. Old access token is rejected by /v1/auth/verify within ADR-019 window (401)
      const afterVerify = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${oldAccessToken}` },
      });
      expect(afterVerify.statusCode).toBe(401);
      if (validateProblem) {
        expect(validateProblem(afterVerify.json())).toBe(true);
      }

      // 8. Login works with new password
      const loginRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'dod3_user@winkey.vn',
          password: 'NewBrandPassword123!',
        },
      });
      expect(loginRes.statusCode).toBe(200);
      if (validateTokenResponse) {
        expect(validateTokenResponse(loginRes.json())).toBe(true);
      }

      // 9. PASSWORD_CHANGED mail arrives
      await mailWorker.processBatchOnce();
      const postMessages = await getMailpitMessages();
      const changedMail = postMessages.find((m) =>
        m.To.some((to) => to.Address.toLowerCase() === 'dod3_user@winkey.vn'),
      );
      expect(changedMail).toBeDefined();

      // DoD Case 4: Re-using the token gives 400
      const reuseRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset',
        payload: {
          token: resetToken,
          new_password: 'YetAnotherPassword123!',
        },
      });
      expect(reuseRes.statusCode).toBe(400);
      const reuseProblem = reuseRes.json();
      if (validateProblem) {
        expect(validateProblem(reuseProblem)).toBe(true);
      }
      expect(reuseProblem.code).toBe('INVALID_TOKEN');
    });

    // DoD Case 5: deleteMe drops pending mail
    it('DoD 5: deleteMe drops pending mail and live tokens', async () => {
      if (!app || !pool || !mailWorker) return;

      // 1. Register user
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'dod5_del@winkey.vn',
          password: 'Password123!',
          handle: 'dod5_del',
          display_name: 'DoD 5 Delete User',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const accessToken = regRes.json().access_token;
      const userId = regRes.json().user.id;

      // 2. Queue a password reset email (without running worker, so mail remains pending)
      const forgotRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/forgot',
        payload: {
          email: 'dod5_del@winkey.vn',
          locale: 'vi',
        },
      });
      expect(forgotRes.statusCode).toBe(202);

      // Verify pending mail exists in DB
      const client = await pool.connect();
      try {
        const pendingCountRes = await client.query(
          `SELECT count(*)::int as cnt FROM auth.mail_queue WHERE user_id = $1 AND sent_at IS NULL AND dead_at IS NULL`,
          [userId],
        );
        expect(pendingCountRes.rows[0].cnt).toBeGreaterThanOrEqual(1);

        const liveTokensRes = await client.query(
          `SELECT count(*)::int as cnt FROM auth.email_tokens WHERE user_id = $1 AND used_at IS NULL`,
          [userId],
        );
        expect(liveTokensRes.rows[0].cnt).toBeGreaterThanOrEqual(1);
      } finally {
        client.release();
      }

      // 3. Call deleteMe
      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          confirm_handle: 'dod5_del',
          password: 'Password123!',
        },
      });
      expect(delRes.statusCode).toBe(204);

      // 4. Verify pending mail and live tokens are dropped
      const verifyClient = await pool.connect();
      try {
        const pendingCountAfter = await verifyClient.query(
          `SELECT count(*)::int as cnt FROM auth.mail_queue WHERE user_id = $1 AND sent_at IS NULL AND dead_at IS NULL`,
          [userId],
        );
        expect(pendingCountAfter.rows[0].cnt).toBe(0);

        const liveTokensAfter = await verifyClient.query(
          `SELECT count(*)::int as cnt FROM auth.email_tokens WHERE user_id = $1 AND used_at IS NULL`,
          [userId],
        );
        expect(liveTokensAfter.rows[0].cnt).toBe(0);
      } finally {
        verifyClient.release();
      }
    });

    it('Task A6: two concurrent resetPassword requests with same token return exactly one 204 and one 400', async () => {
      if (!app || !pool || !testEnv) return;

      // 1. Register user
      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'conc_pg@winkey.vn',
          password: 'Password123!',
          handle: 'conc_pg',
          display_name: 'Conc PG User',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const userId = regRes.json().user.id;

      // 2. Insert reset token into PostgreSQL
      const { rawToken, tokenHash, expiresAt } = generateEmailToken('RESET_PASSWORD');
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO auth.email_tokens (id, user_id, purpose, token_hash, email, expires_at)
           VALUES ($1, $2, 'RESET_PASSWORD', $3, 'conc_pg@winkey.vn', $4)`,
          [uuidv7(), userId, tokenHash, expiresAt],
        );
      } finally {
        client.release();
      }

      // 3. Two concurrent resetPassword requests
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/v1/auth/password/reset',
          payload: {
            token: rawToken,
            new_password: 'NewConcPassword123!_A',
          },
        }),
        app.inject({
          method: 'POST',
          url: '/v1/auth/password/reset',
          payload: {
            token: rawToken,
            new_password: 'NewConcPassword123!_B',
          },
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      expect(statusCodes).toEqual([204, 400]);

      const badRes = res1.statusCode === 400 ? res1 : res2;
      expect(badRes.json().code).toBe('INVALID_TOKEN');
    });
  });
});
