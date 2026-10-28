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
import { ValkeyRateLimiter, type RateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import {
  REFRESH_COOKIE_NAME,
  generateRefreshToken,
  hashRefreshToken,
} from '../../src/crypto/refresh.js';
import { renderEmail } from '../../src/mail/templates.js';
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
    expect(body.user.roles).toEqual(['viewer']);
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
    expect(body.user.roles).toEqual(['viewer']);

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
    expect(verifyRes.headers['x-user-roles']).toBe('viewer');

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

    // 3. REUSE DETECTION: Present old rotated initial token outside grace window
    await pool.query(
      "UPDATE auth.refresh_tokens SET rotated_at = now() - interval '65 seconds' WHERE id = $1",
      [parentQuery.rows[0].id],
    );

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

  it('ADR-019 grace retry: retry within grace window succeeds, revokes unused child, and leaves parent rotated_at immutable', async () => {
    if (!app || !pool) return;

    // 1. Register a user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'grace_ok@winkey.vn',
        password: 'Password123!',
        handle: 'grace_ok',
        display_name: 'Grace OK Test',
      },
    });
    expect(regRes.statusCode).toBe(201);
    await pool.query('DELETE FROM auth.mail_queue WHERE to_email = $1', ['grace_ok@winkey.vn']);
    const parentCookie = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

    // 2. Normal rotation: use parent token to get child 1
    const rotRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
    });
    expect(rotRes.statusCode).toBe(200);
    const child1Cookie = rotRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

    // Check parent and child1 in DB
    const parentRowBefore = (
      await pool.query(
        'SELECT id, family_id, rotated_at, revoked_at FROM auth.refresh_tokens WHERE parent_id IS NULL AND user_id = $1',
        [regRes.json().user.id],
      )
    ).rows[0];
    expect(parentRowBefore.rotated_at).not.toBeNull();
    const rotatedAtBefore = new Date(parentRowBefore.rotated_at).getTime();

    const child1RowBefore = (
      await pool.query(
        'SELECT id, rotated_at, revoked_at FROM auth.refresh_tokens WHERE parent_id = $1',
        [parentRowBefore.id],
      )
    ).rows[0];
    expect(child1RowBefore.revoked_at).toBeNull();
    expect(child1RowBefore.rotated_at).toBeNull();

    // 3. Retry with parent token within grace window (e.g. immediately)
    const retryRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
    });
    expect(retryRes.statusCode).toBe(200);
    const child2Cookie = retryRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;
    expect(child2Cookie).not.toBe(parentCookie);
    expect(child2Cookie).not.toBe(child1Cookie);
    expect(retryRes.json().access_token).toBeDefined();

    // Check DB state:
    // Parent rotated_at is IMMUTABLE (unchanged)
    const parentRowAfter = (
      await pool.query('SELECT rotated_at, revoked_at FROM auth.refresh_tokens WHERE id = $1', [
        parentRowBefore.id,
      ])
    ).rows[0];
    expect(new Date(parentRowAfter.rotated_at).getTime()).toBe(rotatedAtBefore);
    expect(parentRowAfter.revoked_at).toBeNull();

    // Child 1 is revoked
    const child1RowAfter = (
      await pool.query('SELECT revoked_at, rotated_at FROM auth.refresh_tokens WHERE id = $1', [
        child1RowBefore.id,
      ])
    ).rows[0];
    expect(child1RowAfter.revoked_at).not.toBeNull();
    expect(child1RowAfter.rotated_at).toBeNull();

    // Child 2 is alive
    const allChildren = (
      await pool.query(
        'SELECT id, rotated_at, revoked_at FROM auth.refresh_tokens WHERE parent_id = $1 ORDER BY issued_at ASC',
        [parentRowBefore.id],
      )
    ).rows;
    expect(allChildren).toHaveLength(2);
    const aliveChildren = allChildren.filter((c) => c.revoked_at === null && c.rotated_at === null);
    expect(aliveChildren).toHaveLength(1);

    // Metric auth_refresh_total{result="grace_retry"} is exported (prom-client adds default service label)
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.payload).toMatch(/auth_refresh_total\{[^}]*result="grace_retry"[^}]*\} 1/);

    // Using child 1 now should fail (since it was revoked)
    const failChild1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: child1Cookie },
    });
    expect(failChild1.statusCode).toBe(401);

    // Using child 2 succeeds
    const successChild2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: child2Cookie },
    });
    expect(successChild2.statusCode).toBe(200);
  }, 60_000);

  it('ADR-019 grace retry: retry after grace window is treated as reuse and revokes entire family', async () => {
    if (!app || !pool) return;

    // 1. Register a user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'grace_expired@winkey.vn',
        password: 'Password123!',
        handle: 'grace_expired',
        display_name: 'Grace Expired Test',
      },
    });
    expect(regRes.statusCode).toBe(201);
    await pool.query('DELETE FROM auth.mail_queue WHERE to_email = $1', [
      'grace_expired@winkey.vn',
    ]);
    const parentCookie = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

    // 2. Normal rotation: use parent token to get child
    const rotRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
    });
    expect(rotRes.statusCode).toBe(200);

    const parentRow = (
      await pool.query(
        'SELECT id, family_id FROM auth.refresh_tokens WHERE parent_id IS NULL AND user_id = $1',
        [regRes.json().user.id],
      )
    ).rows[0];

    // Artificially move parent.rotated_at past REFRESH_REUSE_GRACE (e.g. 45s ago > 30s)
    await pool.query(
      "UPDATE auth.refresh_tokens SET rotated_at = now() - interval '45 seconds' WHERE id = $1",
      [parentRow.id],
    );

    // 3. Retry with parent token outside grace window -> 401 reuse detected
    const retryRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
    });
    expect(retryRes.statusCode).toBe(401);
    expect(retryRes.json().detail).toBe('Refresh token reuse detected');

    // 4. Entire family revoked in DB
    const familyTokens = (
      await pool.query('SELECT id, revoked_at FROM auth.refresh_tokens WHERE family_id = $1', [
        parentRow.family_id,
      ])
    ).rows;
    expect(familyTokens.length).toBeGreaterThanOrEqual(2);
    for (const t of familyTokens) {
      expect(t.revoked_at).not.toBeNull();
    }
  }, 60_000);

  it('ADR-019 grace retry: retry after child token was used is treated as reuse and revokes entire family', async () => {
    if (!app || !pool) return;

    // 1. Register a user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'child_used@winkey.vn',
        password: 'Password123!',
        handle: 'child_used',
        display_name: 'Child Used Test',
      },
    });
    expect(regRes.statusCode).toBe(201);
    await pool.query('DELETE FROM auth.mail_queue WHERE to_email = $1', ['child_used@winkey.vn']);
    const parentCookie = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

    // 2. Normal rotation: use parent token to get child
    const rotRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
    });
    expect(rotRes.statusCode).toBe(200);
    const childCookie = rotRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

    const parentRow = (
      await pool.query(
        'SELECT id, family_id FROM auth.refresh_tokens WHERE parent_id IS NULL AND user_id = $1',
        [regRes.json().user.id],
      )
    ).rows[0];

    // 3. Child token is USED (rotated) to get grandchild
    const childRotRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: childCookie },
    });
    expect(childRotRes.statusCode).toBe(200);

    // 4. Now parent token is retried (even within grace period window)
    const parentRetryRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
    });
    expect(parentRetryRes.statusCode).toBe(401);
    expect(parentRetryRes.json().detail).toBe('Refresh token reuse detected');

    // 5. Entire family revoked in DB
    const familyTokens = (
      await pool.query('SELECT id, revoked_at FROM auth.refresh_tokens WHERE family_id = $1', [
        parentRow.family_id,
      ])
    ).rows;
    expect(familyTokens.length).toBeGreaterThanOrEqual(3);
    for (const t of familyTokens) {
      expect(t.revoked_at).not.toBeNull();
    }
  }, 60_000);

  it('ADR-019 grace retry: two concurrent retries leave exactly 1 child token alive', async () => {
    if (!app || !pool) return;

    // 1. Register a user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'concurrent_grace@winkey.vn',
        password: 'Password123!',
        handle: 'concurrent_grace',
        display_name: 'Concurrent Grace Test',
      },
    });
    expect(regRes.statusCode).toBe(201);
    await pool.query('DELETE FROM auth.mail_queue WHERE to_email = $1', [
      'concurrent_grace@winkey.vn',
    ]);
    const parentCookie = regRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

    // 2. Initial rotation: creates Child 1
    const rotRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
    });
    expect(rotRes.statusCode).toBe(200);

    const parentRow = (
      await pool.query(
        'SELECT id, family_id FROM auth.refresh_tokens WHERE parent_id IS NULL AND user_id = $1',
        [regRes.json().user.id],
      )
    ).rows[0];

    // 3. Fire 2 concurrent retries with parent token
    const [retryA, retryB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: parentCookie },
      }),
    ]);

    expect(retryA.statusCode).toBe(200);
    expect(retryB.statusCode).toBe(200);

    // 4. Verify DB state: total 3 children created for parent, but EXACTLY 1 child is alive
    const children = (
      await pool.query(
        'SELECT id, rotated_at, revoked_at FROM auth.refresh_tokens WHERE parent_id = $1',
        [parentRow.id],
      )
    ).rows;
    expect(children).toHaveLength(3);

    const aliveChildren = children.filter((c) => c.revoked_at === null && c.rotated_at === null);
    expect(aliveChildren).toHaveLength(1);

    // Parent should NOT be revoked
    const parentAfter = (
      await pool.query('SELECT revoked_at FROM auth.refresh_tokens WHERE id = $1', [parentRow.id])
    ).rows[0];
    expect(parentAfter.revoked_at).toBeNull();
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

  it('Google OAuth: GET /v1/auth/oauth/google returns 302 to /login?error=oauth_unavailable when GOOGLE_CLIENT_ID is not configured', async () => {
    if (!app) return;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/google?return_to=/',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=oauth_unavailable');
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

      // Old token verified with initial roles (ROLE1: new accounts are viewer-only)
      const v1 = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${oldToken}` },
      });
      expect(v1.statusCode).toBe(204);
      expect(v1.headers['x-user-roles']).toBe('viewer');

      // Admin changes roles (grants creator through adminSetUserRoles, which revokes sessions)
      const roleRes = await app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${userId}/roles`,
        headers: {
          'x-user-id': adminId,
          'x-user-roles': 'admin,viewer',
        },
        payload: {
          roles: ['viewer', 'creator'],
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
      expect(refreshRes.json().user.roles).toEqual(['viewer', 'creator']);

      // New token gets 204 with updated roles
      const vNew = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${newToken}` },
      });
      expect(vNew.statusCode).toBe(204);
      expect(vNew.headers['x-user-roles']).toBe('viewer,creator');
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
      const rt2 = refreshLegit.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

      // Legitimate client uses child rt2 first (rotates it -> child is used)
      const refreshLegit2 = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: rt2 },
      });
      expect(refreshLegit2.statusCode).toBe(200);

      // Verify tokenLegit is valid before reuse attack
      const vLegitBefore = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${tokenLegit}` },
      });
      expect(vLegitBefore.statusCode).toBe(204);

      // Attacker uses old rt1 -> triggers reuse detection (child rt2 was already rotated!)
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
        expect(verifyRes.headers['x-user-roles']).toBe('viewer'); // ROLE1 default

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
      await pool.query('DELETE FROM auth.mail_queue');

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
      await pool.query('DELETE FROM auth.mail_queue');

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

  describe('Task ROLE1: Viewer-Only Registration and Creator Requests (ADR-046 DoD)', () => {
    it('register gives [viewer] roles only', async () => {
      if (!app || !pool) return;

      const regRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'role1_reg@winkey.vn',
          password: 'Password123!',
          handle: 'role1_reg',
          display_name: 'Role 1 Reg',
        },
      });
      expect(regRes.statusCode).toBe(201);
      const regBody = regRes.json();
      expect(regBody.user.roles).toEqual(['viewer']);
    });

    it('POST /v1/auth/me/creator-request lifecycle: create -> 201, then REQUEST_PENDING -> 409', async () => {
      if (!app || !pool) return;

      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'creator_applicant1@winkey.vn',
          password: 'Password123!',
          handle: 'applicant1',
          display_name: 'Applicant One',
        },
      });
      const { access_token } = reg.json();

      // 1. Submit creator request -> 201
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${access_token}` },
        payload: { message: 'I make documentary videos about Vietnamese nature.' },
      });
      expect(createRes.statusCode).toBe(201);
      const createBody = createRes.json();
      expect(createBody.status).toBe('PENDING');
      expect(createBody.message).toBe('I make documentary videos about Vietnamese nature.');
      expect(createBody.decision_note).toBeNull();
      expect(createBody.decided_at).toBeNull();
      expect(createBody.created_at).toBeDefined();

      // 2. GET /v1/auth/me/creator-request returns the latest request
      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(createBody.id);

      // 3. Second request while PENDING -> 409 REQUEST_PENDING
      const dupRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${access_token}` },
        payload: { message: 'Trying to submit a second request now.' },
      });
      expect(dupRes.statusCode).toBe(409);
      expect(dupRes.json().code).toBe('REQUEST_PENDING');
    });

    it('already a creator -> 409 ALREADY_CREATOR', async () => {
      if (!app || !pool) return;

      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'already_creator@winkey.vn',
          password: 'Password123!',
          handle: 'already_creator',
          display_name: 'Already Creator',
        },
      });
      const { access_token, user } = reg.json();

      // Grant creator in DB
      await pool.query("UPDATE auth.users SET roles = '{viewer,creator}' WHERE id = $1", [user.id]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${access_token}` },
        payload: { message: 'I already have the creator role.' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('ALREADY_CREATOR');
    });

    it('rejected less than 24h ago -> REQUEST_COOLDOWN, more than 24h ago is allowed', async () => {
      if (!app || !pool) return;

      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'cooldown_user@winkey.vn',
          password: 'Password123!',
          handle: 'cooldown_user',
          display_name: 'Cooldown User',
        },
      });
      const { access_token, user } = reg.json();

      // Insert rejected request 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
      await pool.query(
        `INSERT INTO auth.creator_requests (id, user_id, status, message, decision_note, decided_by, decided_at, created_at)
         VALUES ($1, $2, 'REJECTED', 'Need better audio quality.', 'Please upgrade microphone.', $2, $3, $3)`,
        [uuidv7(), user.id, twoHoursAgo],
      );

      // Submit new request -> 409 REQUEST_COOLDOWN
      const cdRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${access_token}` },
        payload: { message: 'I bought a new microphone now.' },
      });
      expect(cdRes.statusCode).toBe(409);
      expect(cdRes.json().code).toBe('REQUEST_COOLDOWN');
      const expectedAvailable = new Date(twoHoursAgo.getTime() + 24 * 3600 * 1000).toISOString();
      expect(cdRes.json().detail).toContain(expectedAvailable);

      // Now rewind the decided_at in DB to 25 hours ago (> 24h)
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600 * 1000);
      await pool.query('UPDATE auth.creator_requests SET decided_at = $1 WHERE user_id = $2', [
        twentyFiveHoursAgo,
        user.id,
      ]);

      // Submit new request -> 201 Created
      const okRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${access_token}` },
        payload: { message: 'I bought a new microphone and studio setup.' },
      });
      expect(okRes.statusCode).toBe(201);
      expect(okRes.json().status).toBe('PENDING');
    });

    it('rate limit 5 per user per day -> 429', async () => {
      if (!app || !pool || !testEnv) return;

      // The shared app runs with a no-op limiter; this test needs a counting one.
      const limitedApp = await buildApp({
        env: testEnv,
        db: getDb(dbUrl!, pool).db,
        rateLimiter: new ValkeyRateLimiter(),
        redis: redisClient,
      });
      try {
        const reg = await limitedApp.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: 'ratelimit_applicant@winkey.vn',
            password: 'Password123!',
            handle: 'rl_applicant',
            display_name: 'RL Applicant',
          },
        });
        const { access_token, user } = reg.json();

        // Submit 5 requests (cleaning creator_requests table so conflict doesn't block)
        for (let i = 0; i < 5; i++) {
          await pool.query('DELETE FROM auth.creator_requests WHERE user_id = $1', [user.id]);
          const res = await limitedApp.inject({
            method: 'POST',
            url: '/v1/auth/me/creator-request',
            headers: { authorization: `Bearer ${access_token}` },
            payload: { message: `Request attempt number ${i + 1} for rate limit` },
          });
          expect(res.statusCode).toBe(201);
        }

        // 6th attempt -> 429 (the limiter runs before the conflict checks)
        await pool.query('DELETE FROM auth.creator_requests WHERE user_id = $1', [user.id]);
        const res6 = await limitedApp.inject({
          method: 'POST',
          url: '/v1/auth/me/creator-request',
          headers: { authorization: `Bearer ${access_token}` },
          payload: { message: 'Request attempt number 6 should fail' },
        });
        expect(res6.statusCode).toBe(429);
        expect(res6.json().code).toBe('RATE_LIMIT_EXCEEDED');
      } finally {
        await limitedApp.close();
      }
    });

    it('Admin list creator requests: ordering, cursor paging, pending_count, RBAC', async () => {
      if (!app || !pool) return;

      // 1. Setup admin and moderator users
      const adminId = uuidv7();
      const modId = uuidv7();
      const viewerId = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES
         ($1, 'admin_cr@winkey.vn', 'hash', 'admin_cr', 'Admin CR', '{admin,viewer}', 'ACTIVE'),
         ($2, 'mod_cr@winkey.vn', 'hash', 'mod_cr', 'Mod CR', '{moderator,viewer}', 'ACTIVE'),
         ($3, 'viewer_cr@winkey.vn', 'hash', 'viewer_cr', 'Viewer CR', '{viewer}', 'ACTIVE')`,
        [adminId, modId, viewerId],
      );

      const { token: adminToken } = await issueAccessToken(
        { id: adminId, roles: ['admin', 'viewer'] },
        uuidv7(),
        testEnv!,
      );
      const { token: modToken } = await issueAccessToken(
        { id: modId, roles: ['moderator', 'viewer'] },
        uuidv7(),
        testEnv!,
      );
      const { token: viewerToken } = await issueAccessToken(
        { id: viewerId, roles: ['viewer'] },
        uuidv7(),
        testEnv!,
      );

      // RBAC check: viewer -> 403, mod -> 403
      const vRes = await app.inject({
        method: 'GET',
        url: '/v1/admin/creator-requests',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(vRes.statusCode).toBe(403);

      const mRes = await app.inject({
        method: 'GET',
        url: '/v1/admin/creator-requests',
        headers: { authorization: `Bearer ${modToken}` },
      });
      expect(mRes.statusCode).toBe(403);

      // Clear existing creator_requests for pristine test
      await pool.query('DELETE FROM auth.creator_requests');

      // Create 3 applicants with PENDING requests
      const app1 = uuidv7();
      const app2 = uuidv7();
      const app3 = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES
         ($1, 'app1@winkey.vn', 'hash', 'app1', 'App One', '{viewer}', 'ACTIVE'),
         ($2, 'app2@winkey.vn', 'hash', 'app2', 'App Two', '{viewer}', 'ACTIVE'),
         ($3, 'app3@winkey.vn', 'hash', 'app3', 'App Three', '{viewer}', 'ACTIVE')`,
        [app1, app2, app3],
      );

      const t1 = new Date(Date.now() - 3000);
      const t2 = new Date(Date.now() - 2000);
      const t3 = new Date(Date.now() - 1000);
      const reqId1 = uuidv7();
      const reqId2 = uuidv7();
      const reqId3 = uuidv7();

      await pool.query(
        `INSERT INTO auth.creator_requests (id, user_id, status, message, created_at)
         VALUES
         ($1, $4, 'PENDING', 'Message 1 from applicant 1', $7),
         ($2, $5, 'PENDING', 'Message 2 from applicant 2', $8),
         ($3, $6, 'PENDING', 'Message 3 from applicant 3', $9)`,
        [reqId1, reqId2, reqId3, app1, app2, app3, t1, t2, t3],
      );

      // Fetch with limit=2 (page 1)
      const page1Res = await app.inject({
        method: 'GET',
        url: '/v1/admin/creator-requests?limit=2',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = page1Res.json();
      expect(page1.pending_count).toBe(3);
      expect(page1.items).toHaveLength(2);
      // PENDING is ordered created_at ASC, id ASC
      expect(page1.items[0].id).toBe(reqId1);
      expect(page1.items[1].id).toBe(reqId2);
      expect(page1.next_cursor).not.toBeNull();

      // Fetch page 2 using cursor
      const page2Res = await app.inject({
        method: 'GET',
        url: `/v1/admin/creator-requests?limit=2&cursor=${page1.next_cursor}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = page2Res.json();
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).toBe(reqId3);
      expect(page2.next_cursor).toBeNull();
    });

    it('Approve flow: adds creator, writes audit row, does NOT revoke sessions, refresh gets new roles', async () => {
      if (!app || !pool) return;

      // 1. Register normal user
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'approve_test@winkey.vn',
          password: 'Password123!',
          handle: 'approve_test',
          display_name: 'Approve Test',
        },
      });
      const { user: applicantUser, access_token: initialAccessToken } = reg.json();
      const rtCookie = reg.headers['set-cookie'] as string;

      // 2. Submit creator request
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/creator-request',
        headers: { authorization: `Bearer ${initialAccessToken}` },
        payload: { message: 'Please approve my creator upgrade request.' },
      });
      const reqId = createRes.json().id;

      // 3. Admin approves
      const adminId = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES ($1, 'admin_approver@winkey.vn', 'hash', 'admin_approver', 'Admin Approver', '{admin,viewer}', 'ACTIVE')`,
        [adminId],
      );
      const { token: adminToken } = await issueAccessToken(
        { id: adminId, roles: ['admin', 'viewer'] },
        uuidv7(),
        testEnv!,
      );

      const approveRes = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE', note: 'Portfolio looks great!' },
      });
      expect(approveRes.statusCode).toBe(200);
      const appvBody = approveRes.json();
      expect(appvBody.status).toBe('APPROVED');
      expect(appvBody.decision_note).toBe('Portfolio looks great!');
      expect(appvBody.user.roles).toContain('creator');
      expect(appvBody.decided_by.id).toBe(adminId);

      // Check DB user roles
      const userDb = await pool.query('SELECT roles FROM auth.users WHERE id = $1', [
        applicantUser.id,
      ]);
      expect(userDb.rows[0].roles).toContain('creator');

      // Check audit log
      const auditRes = await pool.query(
        "SELECT * FROM auth.audit_log WHERE action = 'USER_ROLES_CHANGED' AND target_user_id = $1",
        [applicantUser.id],
      );
      expect(auditRes.rows).toHaveLength(1);
      const auditDetails =
        typeof auditRes.rows[0].details === 'string'
          ? JSON.parse(auditRes.rows[0].details)
          : auditRes.rows[0].details;
      expect(auditDetails.creator_request_id).toBe(reqId);
      expect(auditDetails.to).toContain('creator');

      // Check NO revocation: refresh token still valid
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: {
          cookie: rtCookie,
          origin: testEnv!.PUBLIC_ORIGIN,
        },
      });
      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = refreshRes.json();
      expect(refreshBody.user.roles).toContain('creator');

      // Initial access token also still valid (stateless JWT until exp)
      const verifyInitial = await app.inject({
        method: 'GET',
        url: '/v1/auth/verify',
        headers: { authorization: `Bearer ${initialAccessToken}` },
      });
      expect(verifyInitial.statusCode).toBe(204);
    });

    it('Approve when user already has creator: status APPROVED, no audit row', async () => {
      if (!app || !pool) return;

      const applicantId = uuidv7();
      const adminId = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES
         ($1, 'has_creator@winkey.vn', 'hash', 'has_creator', 'Has Creator', '{viewer,creator}', 'ACTIVE'),
         ($2, 'admin_dup_appv@winkey.vn', 'hash', 'admin_dup_appv', 'Admin Dup', '{admin,viewer}', 'ACTIVE')`,
        [applicantId, adminId],
      );
      const reqId = uuidv7();
      await pool.query(
        `INSERT INTO auth.creator_requests (id, user_id, status, message)
         VALUES ($1, $2, 'PENDING', 'Request before roles were assigned manually.')`,
        [reqId, applicantId],
      );

      const auditBefore = await pool.query('SELECT count(*) FROM auth.audit_log');
      const countBefore = Number(auditBefore.rows[0].count);

      const { token: adminToken } = await issueAccessToken(
        { id: adminId, roles: ['admin', 'viewer'] },
        uuidv7(),
        testEnv!,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('APPROVED');

      const auditAfter = await pool.query('SELECT count(*) FROM auth.audit_log');
      expect(Number(auditAfter.rows[0].count)).toBe(countBefore); // No new audit row
    });

    it('Approve suspended user -> 409 USER_NOT_ACTIVE', async () => {
      if (!app || !pool) return;

      const applicantId = uuidv7();
      const adminId = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES
         ($1, 'suspended_app@winkey.vn', 'hash', 'susp_app', 'Susp App', '{viewer}', 'SUSPENDED'),
         ($2, 'admin_susp_app@winkey.vn', 'hash', 'admin_susp_app', 'Admin Susp', '{admin,viewer}', 'ACTIVE')`,
        [applicantId, adminId],
      );
      const reqId = uuidv7();
      await pool.query(
        `INSERT INTO auth.creator_requests (id, user_id, status, message)
         VALUES ($1, $2, 'PENDING', 'Suspended user request.')`,
        [reqId, applicantId],
      );

      const { token: adminToken } = await issueAccessToken(
        { id: adminId, roles: ['admin', 'viewer'] },
        uuidv7(),
        testEnv!,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('USER_NOT_ACTIVE');
    });

    it('Reject without note -> 400, with note -> stored, deciding twice -> 409', async () => {
      if (!app || !pool) return;

      const applicantId = uuidv7();
      const adminId = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES
         ($1, 'reject_user@winkey.vn', 'hash', 'reject_user', 'Reject User', '{viewer}', 'ACTIVE'),
         ($2, 'admin_rejector@winkey.vn', 'hash', 'admin_rejector', 'Admin Rejector', '{admin,viewer}', 'ACTIVE')`,
        [applicantId, adminId],
      );
      const reqId = uuidv7();
      await pool.query(
        `INSERT INTO auth.creator_requests (id, user_id, status, message)
         VALUES ($1, $2, 'PENDING', 'Applicant request to be rejected.')`,
        [reqId, applicantId],
      );

      const { token: adminToken } = await issueAccessToken(
        { id: adminId, roles: ['admin', 'viewer'] },
        uuidv7(),
        testEnv!,
      );

      // Reject without note -> 400
      const noNoteRes = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'REJECT' },
      });
      expect(noNoteRes.statusCode).toBe(400);

      // Reject with note -> 200
      const okReject = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'REJECT', note: 'Channels must have at least 3 videos uploaded.' },
      });
      expect(okReject.statusCode).toBe(200);
      expect(okReject.json().status).toBe('REJECTED');
      expect(okReject.json().decision_note).toBe('Channels must have at least 3 videos uploaded.');

      // Deciding twice -> 409 REQUEST_ALREADY_DECIDED
      const secondRes = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE' },
      });
      expect(secondRes.statusCode).toBe(409);
      expect(secondRes.json().code).toBe('REQUEST_ALREADY_DECIDED');
    });

    it('Deciding own request -> 403 CANNOT_MODERATE_TARGET', async () => {
      if (!app || !pool) return;

      const adminId = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES ($1, 'self_admin@winkey.vn', 'hash', 'self_admin', 'Self Admin', '{admin,viewer}', 'ACTIVE')`,
        [adminId],
      );
      const reqId = uuidv7();
      await pool.query(
        `INSERT INTO auth.creator_requests (id, user_id, status, message)
         VALUES ($1, $2, 'PENDING', 'Self decision test request.')`,
        [reqId, adminId],
      );

      const { token: adminToken } = await issueAccessToken(
        { id: adminId, roles: ['admin', 'viewer'] },
        uuidv7(),
        testEnv!,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/creator-requests/${reqId}/decision`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { decision: 'APPROVE' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('CANNOT_MODERATE_TARGET');
    });

    it('Two concurrent decisions: exactly one wins (409 on second)', async () => {
      if (!app || !pool) return;

      const applicantId = uuidv7();
      const admin1 = uuidv7();
      const admin2 = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES
         ($1, 'conc_applicant@winkey.vn', 'hash', 'conc_app', 'Conc App', '{viewer}', 'ACTIVE'),
         ($2, 'admin1@winkey.vn', 'hash', 'admin1', 'Admin 1', '{admin,viewer}', 'ACTIVE'),
         ($3, 'admin2@winkey.vn', 'hash', 'admin2', 'Admin 2', '{admin,viewer}', 'ACTIVE')`,
        [applicantId, admin1, admin2],
      );
      const reqId = uuidv7();
      await pool.query(
        `INSERT INTO auth.creator_requests (id, user_id, status, message)
         VALUES ($1, $2, 'PENDING', 'Concurrent decision test request.')`,
        [reqId, applicantId],
      );

      const { token: token1 } = await issueAccessToken(
        { id: admin1, roles: ['admin', 'viewer'] },
        uuidv7(),
        testEnv!,
      );
      const { token: token2 } = await issueAccessToken(
        { id: admin2, roles: ['admin', 'viewer'] },
        uuidv7(),
        testEnv!,
      );

      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/v1/admin/creator-requests/${reqId}/decision`,
          headers: { authorization: `Bearer ${token1}` },
          payload: { decision: 'APPROVE' },
        }),
        app.inject({
          method: 'POST',
          url: `/v1/admin/creator-requests/${reqId}/decision`,
          headers: { authorization: `Bearer ${token2}` },
          payload: { decision: 'REJECT', note: 'Concurrent reject' },
        }),
      ]);

      const codes = [res1.statusCode, res2.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const conflictRes = res1.statusCode === 409 ? res1 : res2;
      expect(conflictRes.json().code).toBe('REQUEST_ALREADY_DECIDED');
    });
  });

  describe('Task SOC-1a Post-deploy Fixes (ADR-049 Addendum 2026-10-28)', () => {
    it('1. sendStepUpEmailCode queues mail with template STEP_UP_CODE in real Postgres', async () => {
      if (!app || !pool) return;

      const userId = uuidv7();
      const sessionId = uuidv7();
      const email = `stepup_test_${Date.now()}@winkey.vn`;
      const pwdHash = await hashPassword('StepUpPassword123!');

      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES ($1, $2, $3, $4, $5, '{viewer}', 'ACTIVE')`,
        [userId, email, pwdHash, `stepup_${Date.now().toString(36)}`, 'Stepup Tester'],
      );

      await pool.query(
        `INSERT INTO auth.sessions (id, user_id, device_label, country, ip_hash, amr, created_at, last_used_at)
         VALUES ($1, $2, 'Chrome trên Windows', 'VN', $3, '{pwd}', now(), now())`,
        [sessionId, userId, Buffer.alloc(32, 1)],
      );

      const { token: accessToken } = await issueAccessToken(
        { id: userId, roles: ['viewer'] },
        sessionId,
        testEnv!,
      );

      // Call POST /v1/auth/me/step-up/email-code
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up/email-code',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(202);

      // Query auth.mail_queue directly
      const mqRes = await pool.query(
        `SELECT template, params, to_email FROM auth.mail_queue WHERE to_email = $1 ORDER BY created_at DESC LIMIT 1`,
        [email],
      );
      expect(mqRes.rows.length).toBe(1);
      const row = mqRes.rows[0];
      expect(row.template).toBe('STEP_UP_CODE');

      const params = typeof row.params === 'string' ? JSON.parse(row.params) : row.params;
      expect(params.code).toMatch(/^\d{6}$/);

      // Verify template render (vi + en) with real DB params
      const viMail = renderEmail('STEP_UP_CODE', 'vi', params);
      expect(viMail.subject).toContain('xác thực');
      expect(viMail.text).toContain(params.code);
      expect(viMail.html).toContain(params.code);
      expect(viMail.text).toContain('10 phút');
      expect(viMail.text.toLowerCase()).toContain('đổi mật khẩu');
      expect(viMail.text).not.toContain('http');
      expect(viMail.html).not.toContain('<a ');

      const enMail = renderEmail('STEP_UP_CODE', 'en', params);
      expect(enMail.subject).toContain('verification code');
      expect(enMail.text).toContain(params.code);
      expect(enMail.html).toContain(params.code);
      expect(enMail.text).toContain('10 minutes');
      expect(enMail.text.toLowerCase()).toContain('change your password');
      expect(enMail.text).not.toContain('http');
      expect(enMail.html).not.toContain('<a ');
    });

    it('2. routes/refresh.ts lazily creates auth.sessions row for pre-SOC-1a family missing a session', async () => {
      if (!app || !pool) return;

      const userId = uuidv7();
      const familyId = uuidv7();
      const tokenId = uuidv7();
      const email = `legacy_refresh_${Date.now()}@winkey.vn`;
      const pwdHash = await hashPassword('LegacyPassword123!');

      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES ($1, $2, $3, $4, $5, '{viewer}', 'ACTIVE')`,
        [userId, email, pwdHash, `legacy_${Date.now().toString(36)}`, 'Legacy Signin'],
      );

      const opaqueToken = generateRefreshToken();
      const tokenHash = hashRefreshToken(opaqueToken);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // Insert refresh token with familyId but deliberately DO NOT create auth.sessions row
      await pool.query(
        `INSERT INTO auth.refresh_tokens (id, user_id, family_id, token_hash, expires_at, user_agent)
         VALUES ($1, $2, $3, $4, $5, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36')`,
        [tokenId, userId, familyId, tokenHash, expiresAt],
      );

      // Verify no session exists yet
      const preCheck = await pool.query(`SELECT 1 FROM auth.sessions WHERE id = $1`, [familyId]);
      expect(preCheck.rows.length).toBe(0);

      // Call POST /v1/auth/refresh
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
          'cf-ipcountry': 'VN',
        },
        cookies: {
          [REFRESH_COOKIE_NAME]: opaqueToken,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.access_token).toBeDefined();

      // Verify auth.sessions now has exactly 1 row with familyId
      const postCheck = await pool.query(
        `SELECT id, user_id, device_label, country, ip_hash, amr, revoked_at FROM auth.sessions WHERE id = $1`,
        [familyId],
      );
      expect(postCheck.rows.length).toBe(1);
      const session = postCheck.rows[0];
      expect(session.id).toBe(familyId);
      expect(session.user_id).toBe(userId);
      expect(session.device_label).toContain('Chrome');
      expect(session.country).toBe('VN');
      expect(session.ip_hash).not.toBeNull();
      expect(session.amr).toEqual([]);
      expect(session.revoked_at).toBeNull();
    });

    it('3. routes/security.ts POST /v1/auth/me/step-up returns 401 SESSION_NOT_FOUND when session row missing or revoked', async () => {
      if (!app || !pool) return;

      const userId = uuidv7();
      const missingSessionId = uuidv7();
      const email = `missing_sess_${Date.now()}@winkey.vn`;
      const password = 'StepUpPass123!';
      const pwdHash = await hashPassword(password);

      await pool.query(
        `INSERT INTO auth.users (id, email, password_hash, handle, display_name, roles, status)
         VALUES ($1, $2, $3, $4, $5, '{viewer}', 'ACTIVE')`,
        [userId, email, pwdHash, `nosess_${Date.now().toString(36)}`, 'No Session'],
      );

      // Issue token with missingSessionId that does NOT exist in auth.sessions
      const { token: tokenNoSession } = await issueAccessToken(
        { id: userId, roles: ['viewer'] },
        missingSessionId,
        testEnv!,
      );

      const resNoSession = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: { authorization: `Bearer ${tokenNoSession}` },
        payload: {
          method: 'password',
          password,
        },
      });

      expect(resNoSession.statusCode).toBe(401);
      expect(resNoSession.json().code).toBe('SESSION_NOT_FOUND');

      // Now create a revoked session
      const revokedSessionId = uuidv7();
      await pool.query(
        `INSERT INTO auth.sessions (id, user_id, device_label, country, ip_hash, amr, created_at, last_used_at, revoked_at, revoke_reason)
         VALUES ($1, $2, 'Chrome trên Windows', 'VN', $3, '{pwd}', now(), now(), now(), 'USER_REVOKED')`,
        [revokedSessionId, userId, Buffer.alloc(32, 1)],
      );

      const { token: tokenRevokedSession } = await issueAccessToken(
        { id: userId, roles: ['viewer'] },
        revokedSessionId,
        testEnv!,
      );

      const resRevoked = await app.inject({
        method: 'POST',
        url: '/v1/auth/me/step-up',
        headers: { authorization: `Bearer ${tokenRevokedSession}` },
        payload: {
          method: 'password',
          password,
        },
      });

      expect(resRevoked.statusCode).toBe(401);
      expect(resRevoked.json().code).toBe('SESSION_NOT_FOUND');
    });
  });
});
