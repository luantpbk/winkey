import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const chatGet = vi.fn();
const chatPut = vi.fn();
const chatPost = vi.fn();
vi.mock('../../src/lib/api-client', () => ({
  api: {
    chat: {
      GET: (...a: unknown[]) => chatGet(...a),
      PUT: (...a: unknown[]) => chatPut(...a),
      POST: (...a: unknown[]) => chatPost(...a),
    },
  },
}));

import { DeviceManager } from '../../src/lib/e2ee/device-manager';
import type { E2eeClient } from '../../src/lib/e2ee/client';
import { E2eeWorkerEngine } from '../../src/lib/e2ee/engine';
import { E2eeStorage, type E2eeInboundGroupSessionRecord } from '../../src/lib/e2ee/storage';

// Regression for #563 sim runs 1/2 (chatter persona): the page reloaded between saving a new E2EE account in
// IndexedDB and the PUT that registers it, so chat-svc never learned the device and every send failed with 403.

const existing = {
  isNewDevice: false,
  deviceId: '0192f5e4-7c1a-7b3e-9d2a-0000000d0001',
  curve25519Key: 'curve',
  ed25519Key: 'ed',
  signature: 'sig',
  oneTimeKeys: [],
  fallbackKey: null,
};

function fakeClient(overrides: Partial<Record<keyof E2eeClient, unknown>> = {}) {
  return {
    initSession: vi.fn(async () => existing),
    generateOneTimeKeys: vi.fn(async (n: number) =>
      Array.from({ length: n }, (_, i) => ({ key_id: `k${i}`, public_key: `p${i}` })),
    ),
    markKeysPublished: vi.fn(async () => {}),
    ...overrides,
  } as unknown as E2eeClient;
}

const res = (status: number, data?: unknown) => ({
  data,
  error: status >= 400 ? { status } : undefined,
  response: new Response(null, { status }),
});

describe('DeviceManager: a local device chat-svc does not know is registered again', () => {
  beforeEach(() => {
    chatGet.mockReset();
    chatPut.mockReset();
    chatPost.mockReset();
  });

  it('registers it with its own keys and fresh one-time keys when the OTK count answers 404', async () => {
    chatGet.mockResolvedValue(res(404));
    chatPut.mockResolvedValue(res(201, {}));
    chatPost.mockResolvedValue(res(200, {}));
    const client = fakeClient();
    const id = await new DeviceManager(client).ensureDeviceRegistered('user-alice');

    expect(id).toBe(existing.deviceId);
    expect(chatPut).toHaveBeenCalledWith('/v1/chat/devices/{device_id}', {
      params: { path: { device_id: existing.deviceId } },
      body: expect.objectContaining({
        curve25519_key: 'curve',
        ed25519_key: 'ed',
        signature: 'sig',
      }),
    });
    expect(client.generateOneTimeKeys).toHaveBeenCalledWith(50);
    expect(chatPost.mock.calls[0]![0]).toBe('/v1/chat/devices/{device_id}/one-time-keys');
    expect((chatPost.mock.calls[0]![1] as { body: { keys: unknown[] } }).body.keys).toHaveLength(
      50,
    );
  });

  it('leaves a registered device alone (only tops up one-time keys)', async () => {
    chatGet.mockResolvedValue(res(200, { count: 40 }));
    await new DeviceManager(fakeClient()).ensureDeviceRegistered('user-alice');
    expect(chatPut).not.toHaveBeenCalled();
  });

  it('does not keep a failed attempt: the next call tries again', async () => {
    chatGet.mockResolvedValue(res(404));
    chatPut.mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(201, {}));
    chatPost.mockResolvedValue(res(200, {}));
    const manager = new DeviceManager(fakeClient());
    await expect(manager.ensureDeviceRegistered('user-alice')).rejects.toThrow();
    await expect(manager.ensureDeviceRegistered('user-alice')).resolves.toBe(existing.deviceId);
    expect(chatPut).toHaveBeenCalledTimes(2);
  });
});

/** In-memory storage whose reads of inbound sessions yield, so concurrent work can interleave as in IndexedDB. */
class SlowStorage extends E2eeStorage {
  private stores = new Map<string, Map<unknown, unknown>>();
  delays: number[] = [];
  async open(): Promise<IDBDatabase> {
    return {} as IDBDatabase;
  }
  private store(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return this.stores.get(name)!;
  }
  async get<T>(name: string, key: unknown): Promise<T | null> {
    const value = this.store(name).get(key) ?? null;
    if (name === 'inbound_group_sessions') {
      // The first read is slow (a decrypt that started first), later ones are quick: an unserialized writer that
      // started later can finish in between, as IndexedDB transactions do.
      const delay = this.delays.shift() ?? 5;
      await new Promise((r) => setTimeout(r, delay));
    }
    return value as T | null;
  }
  async getAll<T>(name: string): Promise<T[]> {
    return [...this.store(name).values()] as T[];
  }
  async put(name: string, value: Record<string, unknown>): Promise<void> {
    const key =
      value.key ?? value.id ?? value.peer_curve25519 ?? value.conversation_id ?? value.device_id;
    this.store(name).set(key, value);
  }
  async delete(name: string, key: unknown): Promise<void> {
    this.store(name).delete(key);
  }
  async clearStore(name: string): Promise<void> {
    this.store(name).clear();
  }
  close(): void {}
}

describe('Engine: one inbound session is read, changed and written by one caller at a time', () => {
  let wasm: Buffer;
  beforeAll(() => {
    wasm = fs.readFileSync(path.resolve(__dirname, '../../public/wasm/vodozemac_winkey_bg.wasm'));
  });

  it('concurrent decrypts (list preview + conversation view) and a backup mark lose nothing', async () => {
    const storage = new SlowStorage();
    const engine = new E2eeWorkerEngine(storage);
    const me = await engine.initSession('user-alice', wasm);
    const conversationId = 'conv-race';
    const prep = await engine.prepareOutboundMegolm({
      conversationId,
      memberDevices: [
        {
          userId: 'user-alice',
          deviceId: me.deviceId,
          curve25519: me.curve25519Key,
          ed25519: me.ed25519Key,
        },
      ],
      claimedKeys: {},
    });
    const message = await engine.encryptMessage(conversationId, 'Xin chào Bob! E2EE message #1');
    const key = `${conversationId}:${prep.sessionId}`;

    storage.delays = [60];
    // Two decrypts of message #1 at once (preview limit=1 and the view), and a backup mark in between.
    const [a, b] = await Promise.all([
      engine.decryptGroupMessage(conversationId, message.megolmSessionId, message.ciphertext),
      engine.decryptGroupMessage(conversationId, message.megolmSessionId, message.ciphertext),
      engine.backupMarkUploaded([key], 7),
    ]);
    expect(a).toMatchObject({ status: 'DECRYPTED', plaintext: 'Xin chào Bob! E2EE message #1' });
    expect(b).toMatchObject({ status: 'DECRYPTED', plaintext: 'Xin chào Bob! E2EE message #1' });

    // Without the per-session lock a decrypt writes back the record it read before the mark: the mark is lost.
    const rec = await storage.get<E2eeInboundGroupSessionRecord>('inbound_group_sessions', key);
    expect(rec?.backed_up_version).toBe(7);

    // And the session still decrypts afterwards.
    const again = await engine.decryptGroupMessage(
      conversationId,
      message.megolmSessionId,
      message.ciphertext,
    );
    expect(again.status).toBe('DECRYPTED');
  });
});
