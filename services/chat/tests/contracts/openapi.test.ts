import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { buildApp } from '../../src/server.js';
import { loadEnv } from '../../src/config/env.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { generateTestDeviceKeys, generateTestOneTimeKeys } from '../fixtures/keys.js';
import type { FastifyInstance } from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('OpenAPI Contract Verification against chat.v1.yaml and common.yaml', () => {
  let app: FastifyInstance;
  let ajv: Ajv;
  let validateOwnDevice: ValidateFunction;
  let validatePublicDevice: ValidateFunction;
  let validateClaimedKey: ValidateFunction;
  let validateOneTimeKeyCount: ValidateFunction;
  let validateToDeviceMessage: ValidateFunction;
  let validateConversation: ValidateFunction;
  let validateConversationPage: ValidateFunction;
  let validateMember: ValidateFunction;
  let validateMessage: ValidateFunction;
  let validateProblem: ValidateFunction;

  let store: MockStore;

  const userAlice = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
  const userBob = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02';
  const userCharlie = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03';

  const aliceDevice = generateTestDeviceKeys(
    '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd001',
    userAlice,
    'Alice Laptop',
  );
  const bobDevice = generateTestDeviceKeys(
    '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8bd002',
    userBob,
    'Bob Phone',
  );

  beforeAll(async () => {
    // 1. Load OpenAPI contracts
    const chatYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/chat.v1.yaml');
    const commonYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/common.yaml');

    const chatSpec = parseYaml(fs.readFileSync(chatYamlPath, 'utf8'));
    const commonSpec = parseYaml(fs.readFileSync(commonYamlPath, 'utf8'));

    // 2. Setup Ajv
    ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as unknown as (a: unknown) => void)(ajv);

    commonSpec.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
    chatSpec.$id = 'https://winkey.vn/contracts/openapi/chat.v1.yaml';

    ajv.addSchema(commonSpec);
    ajv.addSchema(chatSpec);

    validateOwnDevice = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/OwnDevice',
    )!;
    validatePublicDevice = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/PublicDevice',
    )!;
    validateClaimedKey = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/ClaimedKey',
    )!;
    validateOneTimeKeyCount = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/OneTimeKeyCount',
    )!;
    validateToDeviceMessage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/ToDeviceMessage',
    )!;
    validateConversation = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/Conversation',
    )!;
    validateConversationPage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/ConversationPage',
    )!;
    validateMember = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/Member',
    )!;
    validateMessage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/chat.v1.yaml#/components/schemas/Message',
    )!;
    validateProblem = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/Problem',
    )!;

    // 3. Setup mock store & db
    store = createMockStore();
    store.public_profiles.push(
      {
        id: userAlice,
        handle: 'alice',
        display_name: 'Alice A',
        avatar_key: null,
        bio: null,
        status: 'ACTIVE',
      },
      {
        id: userBob,
        handle: 'bob',
        display_name: 'Bob B',
        avatar_key: null,
        bio: null,
        status: 'ACTIVE',
      },
      {
        id: userCharlie,
        handle: 'charlie',
        display_name: 'Charlie C',
        avatar_key: null,
        bio: null,
        status: 'ACTIVE',
      },
    );

    // Bob follows Alice
    store.subscriptions.push({
      subscriber_id: userBob,
      channel_id: userAlice,
    });

    const mockDb = createMockDb(store);
    const env = loadEnv({ NODE_ENV: 'test' });
    app = await buildApp({ env, db: mockDb });
    await app.ready();
  });

  // ----------------------------------------------------
  // Devices & Keys
  // ----------------------------------------------------
  it('PUT /v1/chat/devices/:device_id registers a new device (201)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${aliceDevice.deviceId}`,
      headers: { 'x-user-id': userAlice },
      payload: {
        display_name: aliceDevice.displayName,
        curve25519_key: aliceDevice.curve25519Key,
        ed25519_key: aliceDevice.ed25519Key,
        signature: aliceDevice.signature,
        fallback_key: aliceDevice.fallbackKey,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    const valid = validateOwnDevice(body);
    expect(valid, JSON.stringify(validateOwnDevice.errors)).toBe(true);
    expect(body.id).toBe(aliceDevice.deviceId);
  });

  it('PUT /v1/chat/devices/:device_id updates existing device (200)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${aliceDevice.deviceId}`,
      headers: { 'x-user-id': userAlice },
      payload: {
        display_name: 'Alice Laptop (Updated)',
        curve25519_key: aliceDevice.curve25519Key,
        ed25519_key: aliceDevice.ed25519Key,
        signature: aliceDevice.signature,
        fallback_key: aliceDevice.fallbackKey,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validateOwnDevice(body)).toBe(true);
    expect(body.display_name).toBe('Alice Laptop (Updated)');
  });

  it('GET /v1/chat/devices lists caller devices', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/chat/devices',
      headers: { 'x-user-id': userAlice },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(validateOwnDevice(item)).toBe(true);
    }
  });

  it('POST /v1/chat/devices/:device_id/one-time-keys uploads signed keys', async () => {
    const otks = generateTestOneTimeKeys(aliceDevice, 5);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/chat/devices/${aliceDevice.deviceId}/one-time-keys`,
      headers: { 'x-user-id': userAlice },
      payload: { keys: otks },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validateOneTimeKeyCount(body)).toBe(true);
    expect(body.count).toBe(5);
  });

  it('POST /v1/chat/devices/query returns public device information', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/devices/query',
      headers: { 'x-user-id': userBob },
      payload: { user_ids: [userAlice, userCharlie] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toBeDefined();
    expect(Array.isArray(body.users)).toBe(true);
    const aliceEntry = body.users.find((u: any) => u.user_id === userAlice);
    expect(aliceEntry).toBeDefined();
    expect(Array.isArray(aliceEntry.devices)).toBe(true);
    for (const d of aliceEntry.devices) {
      expect(validatePublicDevice(d)).toBe(true);
    }
  });

  it('POST /v1/chat/keys/claim claims one-time key or fallback key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/keys/claim',
      headers: { 'x-user-id': userBob },
      payload: { device_ids: [aliceDevice.deviceId] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBe(1);
    const key = body.keys[0];
    expect(validateClaimedKey(key)).toBe(true);
    expect(key.fallback).toBe(false);
  });

  // ----------------------------------------------------
  // To-Device Messaging
  // ----------------------------------------------------
  it('POST /v1/chat/to-device sends Olm-encrypted messages (202)', async () => {
    // Register Bob device first
    await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${bobDevice.deviceId}`,
      headers: { 'x-user-id': userBob },
      payload: {
        display_name: bobDevice.displayName,
        curve25519_key: bobDevice.curve25519Key,
        ed25519_key: bobDevice.ed25519Key,
        signature: bobDevice.signature,
      },
    });

    // Send to-device message to own device
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/to-device',
      headers: { 'x-user-id': userAlice },
      payload: {
        sender_device_id: aliceDevice.deviceId,
        messages: [
          {
            device_id: aliceDevice.deviceId,
            ciphertext: 'T2xtRW5jcnlwdGVkUGF5bG9hZDE=',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(1);
    expect(Array.isArray(body.skipped_device_ids)).toBe(true);
  });

  it('GET /v1/chat/devices/:device_id/to-device lists pending to-device messages', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/chat/devices/${aliceDevice.deviceId}/to-device`,
      headers: { 'x-user-id': userAlice },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.has_more).toBe('boolean');
    for (const msg of body.items) {
      expect(validateToDeviceMessage(msg)).toBe(true);
    }
  });

  it('POST /v1/chat/devices/:device_id/to-device/ack deletes acknowledged messages (204)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/chat/devices/${aliceDevice.deviceId}/to-device/ack`,
      headers: { 'x-user-id': userAlice },
      payload: { up_to: '10' },
    });

    expect(res.statusCode).toBe(204);
  });

  // ----------------------------------------------------
  // Conversations
  // ----------------------------------------------------
  let directConvId: string;
  let groupConvId: string;

  it('POST /v1/chat/conversations creates a DIRECT conversation (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': userAlice },
      payload: {
        kind: 'DIRECT',
        user_ids: [userBob],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(validateConversation(body)).toBe(true);
    expect(body.kind).toBe('DIRECT');
    expect(body.members.length).toBe(2);
    directConvId = body.id;
  });

  it('POST /v1/chat/conversations returns existing DIRECT conversation (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': userAlice },
      payload: {
        kind: 'DIRECT',
        user_ids: [userBob],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validateConversation(body)).toBe(true);
    expect(body.id).toBe(directConvId);
  });

  it('POST /v1/chat/conversations creates a GROUP conversation (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': userAlice },
      payload: {
        kind: 'GROUP',
        title: 'Project Antigravity',
        user_ids: [userBob, userCharlie],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(validateConversation(body)).toBe(true);
    expect(body.kind).toBe('GROUP');
    expect(body.title).toBe('Project Antigravity');
    expect(body.my_role).toBe('OWNER');
    groupConvId = body.id;
  });

  it('GET /v1/chat/conversations/:conversation_id gets conversation details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/chat/conversations/${groupConvId}`,
      headers: { 'x-user-id': userAlice },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validateConversation(body)).toBe(true);
    expect(body.id).toBe(groupConvId);
  });

  it('GET /v1/chat/conversations lists conversations with pagination', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/chat/conversations?state=ACTIVE&limit=10',
      headers: { 'x-user-id': userAlice },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validateConversationPage(body)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    for (const c of body.items) {
      expect(validateConversation(c)).toBe(true);
    }
  });

  it('PATCH /v1/chat/conversations/:conversation_id renames group (200)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/chat/conversations/${groupConvId}`,
      headers: { 'x-user-id': userAlice },
      payload: { title: 'Project Antigravity v2' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validateConversation(body)).toBe(true);
    expect(body.title).toBe('Project Antigravity v2');
  });

  it('PATCH /v1/chat/conversations/:conversation_id/members/:user_id updates member role and mute (200)', async () => {
    // Owner sets Bob as ADMIN
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/chat/conversations/${groupConvId}/members/${userBob}`,
      headers: { 'x-user-id': userAlice },
      payload: { role: 'ADMIN' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validateMember(body)).toBe(true);
    expect(body.role).toBe('ADMIN');

    // Alice mutes conversation for herself
    const muteRes = await app.inject({
      method: 'PATCH',
      url: `/v1/chat/conversations/${groupConvId}/members/${userAlice}`,
      headers: { 'x-user-id': userAlice },
      payload: { muted_until: '2026-11-01T00:00:00.000Z' },
    });

    expect(muteRes.statusCode).toBe(200);
    expect(validateMember(muteRes.json())).toBe(true);
  });

  it('POST /v1/chat/conversations/:conversation_id/read updates read marker (204)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${groupConvId}/read`,
      headers: { 'x-user-id': userAlice },
      payload: { seq: 5 },
    });

    expect(res.statusCode).toBe(204);
  });

  // ----------------------------------------------------
  // Messages
  // ----------------------------------------------------
  let sentSeq: number;

  it('POST /v1/chat/conversations/:conversation_id/messages sends encrypted message (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${groupConvId}/messages`,
      headers: { 'x-user-id': userAlice },
      payload: {
        client_msg_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be001',
        sender_device_id: aliceDevice.deviceId,
        megolm_session_id: 'sess_1234567890',
        ciphertext: 'TWVnb2xtRW5jcnlwdGVkTWVzc2FnZVBheWxvYWQ=',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(validateMessage(body)).toBe(true);
    expect(body.kind).toBe('ENCRYPTED');
    expect(body.ciphertext).toBe('TWVnb2xtRW5jcnlwdGVkTWVzc2FnZVBheWxvYWQ=');
    sentSeq = body.seq;
  });

  it('POST /v1/chat/conversations/:conversation_id/messages returns stored message on duplicate client_msg_id (200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${groupConvId}/messages`,
      headers: { 'x-user-id': userAlice },
      payload: {
        client_msg_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8be001',
        sender_device_id: aliceDevice.deviceId,
        megolm_session_id: 'sess_1234567890',
        ciphertext: 'TWVnb2xtRW5jcnlwdGVkTWVzc2FnZVBheWxvYWQ=',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validateMessage(body)).toBe(true);
    expect(body.seq).toBe(sentSeq);
  });

  it('GET /v1/chat/conversations/:conversation_id/messages lists messages in seq order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/chat/conversations/${groupConvId}/messages?limit=20`,
      headers: { 'x-user-id': userAlice },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.has_more).toBe('boolean');
    for (const msg of body.items) {
      expect(validateMessage(msg)).toBe(true);
    }
  });

  it('DELETE /v1/chat/conversations/:conversation_id/messages/:seq deletes message tombstone (204)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/chat/conversations/${groupConvId}/messages/${sentSeq}`,
      headers: { 'x-user-id': userAlice },
    });

    expect(res.statusCode).toBe(204);
  });

  it('DELETE /v1/chat/conversations/:conversation_id/members/:user_id removes member or leaves (204)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/chat/conversations/${groupConvId}/members/${userCharlie}`,
      headers: { 'x-user-id': userAlice },
    });

    expect(res.statusCode).toBe(204);
  });

  it('DELETE /v1/chat/devices/:device_id removes own device (204)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/chat/devices/${bobDevice.deviceId}`,
      headers: { 'x-user-id': userBob },
    });

    expect(res.statusCode).toBe(204);
  });

  // ----------------------------------------------------
  // Problem Details (RFC 9457)
  // ----------------------------------------------------
  it('returns valid RFC 9457 Problem Details document on errors', async () => {
    // 401 Unauthorized
    const res401 = await app.inject({
      method: 'GET',
      url: '/v1/chat/devices',
    });
    expect(res401.statusCode).toBe(401);
    expect(validateProblem(res401.json())).toBe(true);

    // 404 Not Found
    const res404 = await app.inject({
      method: 'GET',
      url: '/v1/chat/conversations/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c99',
      headers: { 'x-user-id': userAlice },
    });
    expect(res404.statusCode).toBe(404);
    expect(validateProblem(res404.json())).toBe(true);

    // 400 Bad Request
    const res400 = await app.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': userAlice },
      payload: { kind: 'INVALID_KIND' },
    });
    expect(res400.statusCode).toBe(400);
    expect(validateProblem(res400.json())).toBe(true);
  });
});
