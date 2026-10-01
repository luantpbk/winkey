import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { REFRESH_COOKIE_NAME } from '../../src/crypto/refresh.js';

describe('OpenAPI Contract Verification against auth.v1.yaml and common.yaml', () => {
  let app: FastifyInstance;
  let ajv: Ajv;
  let validateTokenResponse: ValidateFunction;
  let validateUser: ValidateFunction;
  let validatePublicProfile: ValidateFunction;
  let validateProblem: ValidateFunction;
  let validateAdminUser: ValidateFunction;
  let validateAdminUserPage: ValidateFunction;
  let validateAuditEntryPage: ValidateFunction;
  let validateUpdateMeRequest: ValidateFunction;
  let validateChangePasswordRequest: ValidateFunction;
  let validateDeleteMeRequest: ValidateFunction;
  let validatePasswordResetRequest: ValidateFunction;
  let validateResetPasswordRequest: ValidateFunction;
  let validateVerifyEmailRequest: ValidateFunction;

  beforeAll(async () => {
    // 1. Load OpenAPI contracts
    const authYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/auth.v1.yaml');
    const commonYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/common.yaml');

    const authSpec = parseYaml(fs.readFileSync(authYamlPath, 'utf8'));
    const commonSpec = parseYaml(fs.readFileSync(commonYamlPath, 'utf8'));

    // 2. Setup Ajv
    ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as (a: unknown) => void)(ajv);

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
    validateUpdateMeRequest = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/UpdateMeRequest',
    )!;
    validateChangePasswordRequest = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/ChangePasswordRequest',
    )!;
    validateDeleteMeRequest = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/DeleteMeRequest',
    )!;
    validatePasswordResetRequest = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/PasswordResetRequest',
    )!;
    validateResetPasswordRequest = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/ResetPasswordRequest',
    )!;
    validateVerifyEmailRequest = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/auth.v1.yaml#/components/schemas/VerifyEmailRequest',
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
    const cookie = loginRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;

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

  it('Validates Task A3 account self-service schemas (User.has_password, requests, 204s, and Problem errors)', async () => {
    // 1. Validate request schemas
    const validUpdateMeReq = { display_name: 'New Name', handle: 'new_handle' };
    expect(validateUpdateMeRequest(validUpdateMeReq)).toBe(true);
    expect(validateUpdateMeRequest({})).toBe(false); // minProperties: 1

    const validChangePwdReq = {
      current_password: 'OldPassword123!',
      new_password: 'NewPassword123!',
    };
    expect(validateChangePasswordRequest(validChangePwdReq)).toBe(true);
    expect(validateChangePasswordRequest({ new_password: 'short' })).toBe(false); // minLength: 8

    const validDelReq = { confirm_handle: 'my_handle', password: 'Password123!' };
    expect(validateDeleteMeRequest(validDelReq)).toBe(true);
    expect(validateDeleteMeRequest({})).toBe(false); // confirm_handle required

    // 2. Register user
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'a3_contract@winkey.vn',
        password: 'Password123!',
        handle: 'a3_contract',
        display_name: 'A3 Contract',
      },
    });
    const token = regRes.json().access_token;

    // 3. GET /v1/auth/me returns User with has_password
    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = meRes.json();
    expect(validateUser(meBody)).toBe(true);
    expect(meBody.has_password).toBe(true);

    // 4. PATCH /v1/auth/me returns User with has_password
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { display_name: 'A3 Contract Renamed' },
    });
    expect(patchRes.statusCode).toBe(200);
    const patchBody = patchRes.json();
    expect(validateUser(patchBody)).toBe(true);
    expect(patchBody.display_name).toBe('A3 Contract Renamed');
    expect(patchBody.has_password).toBe(true);

    // 5. Error response validates against Problem schema
    const conflictRes = await app.inject({
      method: 'PATCH',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { handle: 'contract_user' }, // Already exists from earlier contract test
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(validateProblem(conflictRes.json())).toBe(true);

    // 6. PUT /v1/auth/me/password returns 204
    const changePwdRes = await app.inject({
      method: 'PUT',
      url: '/v1/auth/me/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: 'Password123!', new_password: 'NewSecurePassword123!' },
    });
    expect(changePwdRes.statusCode).toBe(204);

    // 7. DELETE /v1/auth/me returns 204
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm_handle: 'a3_contract', password: 'NewSecurePassword123!' },
    });
    expect(delRes.statusCode).toBe(204);
  });

  it('Validates A6 password reset and email verification contract schemas and responses', async () => {
    // 1. PasswordResetRequest schema validation
    const forgotPayload = { email: 'user@winkey.vn', locale: 'vi' };
    expect(validatePasswordResetRequest(forgotPayload)).toBe(true);

    const forgotRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      payload: forgotPayload,
    });
    expect(forgotRes.statusCode).toBe(202);
    expect(forgotRes.body).toBe('');

    // 2. ResetPasswordRequest schema validation
    const resetPayload = {
      token: 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
      new_password: 'NewStrongPassword123!',
    };
    expect(validateResetPasswordRequest(resetPayload)).toBe(true);

    const resetBadRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      payload: resetPayload,
    });
    expect(resetBadRes.statusCode).toBe(400);
    const resetProblem = resetBadRes.json();
    expect(validateProblem(resetProblem)).toBe(true);
    expect(resetProblem.code).toBe('INVALID_TOKEN');

    // 3. VerifyEmailRequest schema validation
    const verifyPayload = {
      token: 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE',
    };
    expect(validateVerifyEmailRequest(verifyPayload)).toBe(true);

    const verifyBadRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/verify',
      payload: verifyPayload,
    });
    expect(verifyBadRes.statusCode).toBe(400);
    const verifyProblem = verifyBadRes.json();
    expect(validateProblem(verifyProblem)).toBe(true);
    expect(verifyProblem.code).toBe('INVALID_TOKEN');
  });
});
