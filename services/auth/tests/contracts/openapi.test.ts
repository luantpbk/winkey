import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import _Ajv from 'ajv';
import addFormats from 'ajv-formats';
const Ajv = (_Ajv as any).default ?? _Ajv;
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { REFRESH_COOKIE_NAME } from '../../src/crypto/refresh.js';

describe('OpenAPI Contract Verification against auth.v1.yaml and common.yaml', () => {
  let app: any;
  let ajv: any;
  let validateTokenResponse: any;
  let validateUser: any;
  let validatePublicProfile: any;
  let validateProblem: any;
  let validateAdminUser: any;
  let validateAdminUserPage: any;
  let validateAuditEntryPage: any;

  beforeAll(async () => {
    // 1. Load OpenAPI contracts
    const authYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/auth.v1.yaml');
    const commonYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/common.yaml');

    const authSpec = parseYaml(fs.readFileSync(authYamlPath, 'utf8'));
    const commonSpec = parseYaml(fs.readFileSync(commonYamlPath, 'utf8'));

    // 2. Setup Ajv
    ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as any)(ajv);

    commonSpec.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
    authSpec.$id = 'https://winkey.vn/contracts/openapi/auth.v1.yaml';

    ajv.addSchema(commonSpec);
    ajv.addSchema(authSpec);

    validateTokenResponse = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/TokenResponse',
    )!;
    validateUser = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/User',
    )!;
    validatePublicProfile = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/PublicProfile',
    )!;
    validateProblem = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/Problem',
    )!;
    validateAdminUser = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/AdminUser',
    )!;
    validateAdminUserPage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/AdminUserPage',
    )!;
    validateAuditEntryPage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/AuditEntryPage',
    )!;

    // 3. Build test app
    const keys = getTestKeys();
    const env = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_KID: 'winkey-auth-key-1',
      JWT_ISSUER: 'https://winkey.vn',
      PUBLIC_ORIGIN: 'https://winkey.vn',
      MEDIA_BASE_URL: 'https://media.winkey.vn',
      NODE_ENV: 'test',
    });

    const store = createMockStore();
    const { db } = createMockDb(store);
    const rateLimiter = new ValkeyRateLimiter();

    app = await buildApp({
      env,
      db,
      rateLimiter,
    });
  });

  it('Validates 201 Register response against TokenResponse schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'contract_test@winkey.vn',
        password: 'SecurePassword123!',
        handle: 'contract_user',
        display_name: 'Contract User',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    const valid = validateTokenResponse(body);
    if (!valid) {
      console.error(validateTokenResponse.errors);
    }
    expect(valid).toBe(true);
  });

  it('Validates 200 Login response against TokenResponse schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'contract_test@winkey.vn',
        password: 'SecurePassword123!',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validateTokenResponse(body);
    expect(valid).toBe(true);
  });

  it('Validates 200 Refresh response against TokenResponse schema', async () => {
    // Get refresh cookie from login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'contract_test@winkey.vn',
        password: 'SecurePassword123!',
      },
    });
    const cookie = loginRes.cookies.find((c: any) => c.name === REFRESH_COOKIE_NAME)!.value;

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });

    expect(refreshRes.statusCode).toBe(200);
    const body = refreshRes.json();
    const valid = validateTokenResponse(body);
    expect(valid).toBe(true);
  });

  it('Validates 200 /v1/auth/me response against User schema', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'contract_test@winkey.vn',
        password: 'SecurePassword123!',
      },
    });
    const { access_token } = loginRes.json();

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { Authorization: `Bearer ${access_token}` },
    });

    expect(meRes.statusCode).toBe(200);
    const body = meRes.json();
    const valid = validateUser(body);
    if (!valid) {
      console.error(validateUser.errors);
    }
    expect(valid).toBe(true);
  });

  it('Validates 200 /v1/users/{handle} response against PublicProfile schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/contract_user',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validatePublicProfile(body);
    if (!valid) {
      console.error(validatePublicProfile.errors);
    }
    expect(valid).toBe(true);
  });

  it('Validates 400, 401, 404, 409 error responses against Problem schema', async () => {
    // 400 Bad Request
    const badReq = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'bad' },
    });
    expect(badReq.statusCode).toBe(400);
    expect(badReq.headers['content-type']).toContain('application/problem+json');
    expect(validateProblem(badReq.json())).toBe(true);

    // 401 Unauthorized
    const unauth = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'unknown@winkey.vn', password: 'bad' },
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers['content-type']).toContain('application/problem+json');
    expect(validateProblem(unauth.json())).toBe(true);

    // 404 Not Found
    const notFound = await app.inject({
      method: 'GET',
      url: '/v1/users/nonexistent_handle',
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.headers['content-type']).toContain('application/problem+json');
    expect(validateProblem(notFound.json())).toBe(true);

    // 409 Conflict
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'contract_test@winkey.vn',
        password: 'Password123!',
        handle: 'contract_user2',
        display_name: 'Name',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.headers['content-type']).toContain('application/problem+json');
    expect(validateProblem(conflict.json())).toBe(true);
  });

  it('Validates admin endpoints responses against OpenAPI schemas', async () => {
    // 1. Setup admin and target user
    const adminId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
    const adminHeaders = {
      'x-user-id': adminId,
      'x-user-roles': 'admin,viewer',
    };

    // Register a user to be managed
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'target_admin_test@winkey.vn',
        password: 'Password123!',
        handle: 'target_admin_test',
        display_name: 'Target Admin Test',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const targetId = regRes.json().user.id;

    // GET /v1/admin/users -> AdminUserPage
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/users',
      headers: adminHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    const validPage = validateAdminUserPage(listBody);
    if (!validPage) console.error(validateAdminUserPage.errors);
    expect(validPage).toBe(true);

    // GET /v1/admin/users/{user_id} -> AdminUser
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/${targetId}`,
      headers: adminHeaders,
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json();
    const validUser = validateAdminUser(getBody);
    if (!validUser) console.error(validateAdminUser.errors);
    expect(validUser).toBe(true);

    // PUT /v1/admin/users/{user_id}/roles -> AdminUser
    const rolesRes = await app.inject({
      method: 'PUT',
      url: `/v1/admin/users/${targetId}/roles`,
      headers: adminHeaders,
      payload: {
        roles: ['viewer', 'creator', 'moderator'],
      },
    });
    expect(rolesRes.statusCode).toBe(200);
    const rolesBody = rolesRes.json();
    expect(validateAdminUser(rolesBody)).toBe(true);
    expect(rolesBody.roles).toContain('moderator');

    // PUT /v1/admin/users/{user_id}/suspension -> AdminUser
    const suspRes = await app.inject({
      method: 'PUT',
      url: `/v1/admin/users/${targetId}/suspension`,
      headers: adminHeaders,
      payload: {
        reason: 'Violation of community guidelines',
        until: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    expect(suspRes.statusCode).toBe(200);
    const suspBody = suspRes.json();
    expect(validateAdminUser(suspBody)).toBe(true);
    expect(suspBody.status).toBe('SUSPENDED');

    // DELETE /v1/admin/users/{user_id}/suspension -> AdminUser
    const unsuspRes = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${targetId}/suspension`,
      headers: adminHeaders,
    });
    expect(unsuspRes.statusCode).toBe(200);
    const unsuspBody = unsuspRes.json();
    expect(validateAdminUser(unsuspBody)).toBe(true);
    expect(unsuspBody.status).toBe('ACTIVE');

    // GET /v1/admin/audit-log -> AuditEntryPage
    const auditRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log',
      headers: adminHeaders,
    });
    expect(auditRes.statusCode).toBe(200);
    const auditBody = auditRes.json();
    const validAudit = validateAuditEntryPage(auditBody);
    if (!validAudit) console.error(validateAuditEntryPage.errors);
    expect(validAudit).toBe(true);
  });
});
