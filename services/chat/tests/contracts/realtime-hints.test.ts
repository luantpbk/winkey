import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { RealtimeHintDispatcher, type ChatHint } from '../../src/realtime/hints.js';
import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sc = StringCodec();

describe('Realtime Hints Contract Verification (contracts/realtime/server.schema.json)', () => {
  let validateChatHint: ValidateFunction;
  let serverSchema: Record<string, unknown>;

  beforeAll(() => {
    // 1. Locate repository root and read contracts/realtime/server.schema.json
    let repoRoot = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(repoRoot, 'contracts', 'realtime', 'server.schema.json'))) {
        break;
      }
      repoRoot = path.dirname(repoRoot);
    }

    const schemaPath = path.join(repoRoot, 'contracts', 'realtime', 'server.schema.json');
    serverSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    // 2. Initialize Ajv 2020
    const AjvClass = Ajv2020 as unknown as new (
      opts?: Record<string, unknown>,
    ) => import('ajv').default;
    const ajv = new AjvClass({
      strict: false,
      allErrors: true,
    });
    (addFormats as unknown as (a: unknown) => void)(ajv);

    ajv.addSchema(serverSchema, 'https://winkey.vn/contracts/realtime/server.schema.json');

    // 3. Compile validator specifically for #/$defs/chatHint
    validateChatHint = ajv.compile({
      $ref: 'https://winkey.vn/contracts/realtime/server.schema.json#/$defs/chatHint',
    });
  });

  function setupDispatcher() {
    const published: Array<{ subject: string; payload: unknown; raw: string }> = [];

    const mockNc = {
      isClosed: () => false,
      publish: (subject: string, data: Uint8Array) => {
        const raw = sc.decode(data);
        published.push({
          subject,
          payload: JSON.parse(raw),
          raw,
        });
      },
    } as unknown as NatsConnection;

    const dispatcher = new RealtimeHintDispatcher(mockNc);
    return { dispatcher, published, mockNc };
  }

  it('validates MESSAGE hint against $defs/chatHint', () => {
    const { dispatcher, published } = setupDispatcher();
    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
    const convId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02';

    const hint: ChatHint = {
      kind: 'MESSAGE',
      conversation_id: convId,
      seq: 42,
    };

    dispatcher.publishHint(userId, hint);

    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe(`rt.chat.user.${userId}`);
    expect(published[0].payload).toEqual(hint);

    const isValid = validateChatHint(published[0].payload);
    expect(validateChatHint.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates TO_DEVICE hint against $defs/chatHint', () => {
    const { dispatcher, published } = setupDispatcher();
    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';

    const hint: ChatHint = {
      kind: 'TO_DEVICE',
    };

    dispatcher.publishHint(userId, hint);

    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe(`rt.chat.user.${userId}`);
    expect(published[0].payload).toEqual(hint);

    const isValid = validateChatHint(published[0].payload);
    expect(validateChatHint.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates CONVERSATION hint against $defs/chatHint', () => {
    const { dispatcher, published } = setupDispatcher();
    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
    const convId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03';

    const hint: ChatHint = {
      kind: 'CONVERSATION',
      conversation_id: convId,
    };

    dispatcher.publishHint(userId, hint);

    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe(`rt.chat.user.${userId}`);
    expect(published[0].payload).toEqual(hint);

    const isValid = validateChatHint(published[0].payload);
    expect(validateChatHint.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates DEVICES hint against $defs/chatHint', () => {
    const { dispatcher, published } = setupDispatcher();
    const targetUserId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
    const peerUserId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02';

    const hint: ChatHint = {
      kind: 'DEVICES',
      user_id: peerUserId,
    };

    dispatcher.publishHint(targetUserId, hint);

    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe(`rt.chat.user.${targetUserId}`);
    expect(published[0].payload).toEqual(hint);

    const isValid = validateChatHint(published[0].payload);
    expect(validateChatHint.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('validates READ hint against $defs/chatHint (B3, chat.v1 1.3.0)', () => {
    const { dispatcher, published } = setupDispatcher();
    const targetUserId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
    const hint: ChatHint = {
      kind: 'READ',
      conversation_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03',
      user_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
      seq: 42,
    };

    dispatcher.publishHint(targetUserId, hint);

    expect(published[0].payload).toEqual(hint);
    const isValid = validateChatHint(published[0].payload);
    expect(validateChatHint.errors).toBeNull();
    expect(isValid).toBe(true);
    expect(validateChatHint({ ...hint, seq: -1 })).toBe(false);
    expect(validateChatHint({ kind: 'READ', conversation_id: hint.conversation_id, seq: 1 })).toBe(
      false,
    );
  });

  it('broadcasts hints to multiple recipients using publishHints', () => {
    const { dispatcher, published } = setupDispatcher();
    const user1 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
    const user2 = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02';
    const convId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03';

    const hint: ChatHint = {
      kind: 'CONVERSATION',
      conversation_id: convId,
    };

    dispatcher.publishHints([user1, user2], hint);

    expect(published).toHaveLength(2);
    expect(published[0].subject).toBe(`rt.chat.user.${user1}`);
    expect(published[1].subject).toBe(`rt.chat.user.${user2}`);
    expect(validateChatHint(published[0].payload)).toBe(true);
    expect(validateChatHint(published[1].payload)).toBe(true);
  });

  it('works with dynamic getter (() => NatsConnection | null)', () => {
    const published: Array<{ subject: string; payload: unknown }> = [];
    let currentNc: NatsConnection | null = null;

    const dispatcher = new RealtimeHintDispatcher(() => currentNc);
    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';

    // 1. Connection is not yet ready -> no throw, no publish
    dispatcher.publishHint(userId, { kind: 'TO_DEVICE' });
    expect(published).toHaveLength(0);

    // 2. Connection comes up -> publishes
    currentNc = {
      isClosed: () => false,
      publish: (subject: string, data: Uint8Array) => {
        published.push({ subject, payload: JSON.parse(sc.decode(data)) });
      },
    } as unknown as NatsConnection;

    dispatcher.publishHint(userId, { kind: 'TO_DEVICE' });
    expect(published).toHaveLength(1);
    expect(validateChatHint(published[0].payload)).toBe(true);
  });

  describe('Strict negative schema tests', () => {
    it('rejects invalid uuid in conversation_id', () => {
      const invalid = { kind: 'MESSAGE', conversation_id: 'invalid-uuid-123', seq: 1 };
      const isValid = validateChatHint(invalid);
      expect(isValid).toBe(false);
      expect(validateChatHint.errors?.length).toBeGreaterThan(0);
    });

    it('rejects non-positive seq numbers (seq must be >= 1)', () => {
      const invalid = {
        kind: 'MESSAGE',
        conversation_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        seq: 0,
      };
      const isValid = validateChatHint(invalid);
      expect(isValid).toBe(false);
    });

    it('rejects unexpected properties due to additionalProperties: false', () => {
      const invalid = {
        kind: 'TO_DEVICE',
        secret_payload: 'should-not-be-allowed',
      };
      const isValid = validateChatHint(invalid);
      expect(isValid).toBe(false);
    });

    it('rejects unrecognized hint kinds', () => {
      const invalid = { kind: 'RANDOM_KIND' };
      const isValid = validateChatHint(invalid);
      expect(isValid).toBe(false);
    });
  });
});
