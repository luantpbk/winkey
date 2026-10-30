import { describe, it, expect, beforeAll } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { buildApp } from '../../src/server.js';
import { createMockStore, createMockDb } from '../fixtures/mock-db.js';
import { generateTestDeviceKeys, generateTestOneTimeKeys } from '../fixtures/keys.js';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyInstance } from 'fastify';

describe('Log Privacy Verification (ADR-049 & Hard Rules)', () => {
  let app: FastifyInstance;
  let capturedLogs: string[] = [];

  const secretCiphertextToDevice = 'CIPHERTEXT_TO_DEVICE_SUPER_SECRET_PAYLOAD_99999';
  const secretCiphertextMessage = 'CIPHERTEXT_MEGOLM_SUPER_SECRET_PAYLOAD_88888';

  const userAlice = uuidv7();
  const userBob = uuidv7();
  const aliceDeviceId = uuidv7();
  let aliceKeys: ReturnType<typeof generateTestDeviceKeys>;

  beforeAll(async () => {
    // Custom Pino stream capturing all log records
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLogs.push(chunk.toString());
        callback();
      },
    });

    const testLogger = pino(
      {
        level: 'trace',
        redact: {
          paths: [
            'req.body.ciphertext',
            'req.body.keys',
            'req.body.messages[*].ciphertext',
            'req.body.curve25519_key',
            'req.body.ed25519_key',
            'req.body.signature',
            'req.body.fallback_key',
            'res.body.ciphertext',
            'res.body.curve25519_key',
            'res.body.ed25519_key',
            'res.body.signature',
            'ciphertext',
            'curve25519_key',
            'ed25519_key',
            'signature',
            '*.ciphertext',
          ],
          censor: '[REDACTED]',
        },
      },
      logStream,
    );

    const store = createMockStore();
    store.public_profiles.push(
      {
        id: userAlice,
        handle: 'alice',
        display_name: 'Alice',
        avatar_key: null,
        bio: null,
        status: 'ACTIVE',
      },
      {
        id: userBob,
        handle: 'bob',
        display_name: 'Bob',
        avatar_key: null,
        bio: null,
        status: 'ACTIVE',
      },
    );

    const mockDb = createMockDb(store);

    app = await buildApp({
      db: mockDb,
      loggerInstance: testLogger,
    });

    aliceKeys = generateTestDeviceKeys(aliceDeviceId, userAlice, 'Alice Device');
  });

  it('never logs keys, signatures, or ciphertext during device registration', async () => {
    capturedLogs = [];

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/chat/devices/${aliceDeviceId}`,
      headers: { 'x-user-id': userAlice },
      payload: {
        display_name: "Alice's Secret Phone",
        curve25519_key: aliceKeys.curve25519Key,
        ed25519_key: aliceKeys.ed25519Key,
        signature: aliceKeys.signature,
        fallback_key: aliceKeys.fallbackKey,
      },
    });

    expect(res.statusCode).toBe(201);

    const combinedLog = capturedLogs.join('\n');
    expect(combinedLog).not.toContain(aliceKeys.curve25519Key);
    expect(combinedLog).not.toContain(aliceKeys.ed25519Key);
    expect(combinedLog).not.toContain(aliceKeys.signature);
    if (aliceKeys.fallbackKey) {
      expect(combinedLog).not.toContain(aliceKeys.fallbackKey.public_key);
      expect(combinedLog).not.toContain(aliceKeys.fallbackKey.signature);
    }
  });

  it('never logs one-time keys or signatures during key upload', async () => {
    capturedLogs = [];

    const otks = generateTestOneTimeKeys(aliceKeys, 2, 1);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/chat/devices/${aliceDeviceId}/one-time-keys`,
      headers: { 'x-user-id': userAlice },
      payload: {
        keys: otks,
      },
    });

    expect(res.statusCode).toBe(200);

    const combinedLog = capturedLogs.join('\n');
    for (const otk of otks) {
      expect(combinedLog).not.toContain(otk.public_key);
      expect(combinedLog).not.toContain(otk.signature);
    }
  });

  it('never logs to-device ciphertext during message dispatch', async () => {
    capturedLogs = [];

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/to-device',
      headers: { 'x-user-id': userAlice },
      payload: {
        sender_device_id: aliceDeviceId,
        messages: [
          {
            device_id: aliceDeviceId,
            ciphertext: secretCiphertextToDevice,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(202);

    const combinedLog = capturedLogs.join('\n');
    expect(combinedLog).not.toContain(secretCiphertextToDevice);
  });

  it('never logs Megolm message ciphertext during conversation messaging', async () => {
    // First create a group conversation
    const convRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/conversations',
      headers: { 'x-user-id': userAlice },
      payload: {
        kind: 'GROUP',
        title: 'Privacy Secret Chat',
        user_ids: [userBob],
      },
    });
    expect(convRes.statusCode).toBe(201);
    const convId = convRes.json().id;

    capturedLogs = [];

    const msgRes = await app.inject({
      method: 'POST',
      url: `/v1/chat/conversations/${convId}/messages`,
      headers: { 'x-user-id': userAlice },
      payload: {
        client_msg_id: uuidv7(),
        sender_device_id: aliceDeviceId,
        megolm_session_id: 'secret_session_xyz',
        ciphertext: secretCiphertextMessage,
      },
    });

    expect(msgRes.statusCode).toBe(201);

    const combinedLog = capturedLogs.join('\n');
    expect(combinedLog).not.toContain(secretCiphertextMessage);
  });
});
