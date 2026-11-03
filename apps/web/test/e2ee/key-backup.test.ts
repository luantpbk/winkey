import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { E2eeWorkerEngine } from '../../src/lib/e2ee/engine';
import { E2eeStorage } from '../../src/lib/e2ee/storage';
import {
  ARGON2_M_KIB,
  ARGON2_P,
  ARGON2_T,
  BackupError,
  checkOwnPassphrase,
  createAuthData,
  fromB64u,
  generatePassphrase,
  libsodiumArgon2id,
  openSession,
  sealSession,
  toB64u,
  unlockAuthData,
  type Argon2id,
} from '../../src/lib/e2ee/key-backup';
import { EFF_SHORT_WORDLIST } from '../../src/lib/e2ee/eff-short-wordlist';

const apiChat = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../src/lib/api-client', () => ({ api: { chat: apiChat } }));
import { KeyBackupService } from '../../src/lib/e2ee/key-backup-service';

class MemoryE2eeStorage extends E2eeStorage {
  private stores = new Map<string, Map<unknown, any>>();
  async open(): Promise<IDBDatabase> {
    return {} as IDBDatabase;
  }
  private store(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return this.stores.get(name)!;
  }
  async get<T>(name: string, key: IDBValidKey): Promise<T | null> {
    return this.store(name).get(key) ?? null;
  }
  async getAll<T>(name: string): Promise<T[]> {
    return [...this.store(name).values()];
  }
  async put(name: string, value: any): Promise<void> {
    this.store(name).set(
      value.key ?? value.id ?? value.peer_curve25519 ?? value.conversation_id ?? value.device_id,
      value,
    );
  }
  async delete(name: string, key: IDBValidKey): Promise<void> {
    this.store(name).delete(key);
  }
  async clearStore(name: string): Promise<void> {
    this.store(name).clear();
  }
}

/** A fast stand-in for Argon2id (the real one costs 64 MiB per call); records the parameters it was given. */
const seen: Array<{ mKib: number; t: number; p: number }> = [];
const fakeArgon2id: Argon2id = async (passphrase, salt, params) => {
  seen.push(params);
  const data = new Uint8Array([...new TextEncoder().encode(passphrase), ...salt]);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
};

describe('SOC-3b key backup: crypto', () => {
  it('derives with Argon2id m = 64 MiB, t = 3, p = 1 and a 16-byte salt, in the contract auth_data shape', async () => {
    seen.length = 0;
    const { authData, backupKey } = await createAuthData('ngựa pin kẹp giấy đúng', fakeArgon2id);
    expect(seen).toEqual([{ mKib: 65536, t: 3, p: 1 }]);
    expect([ARGON2_M_KIB, ARGON2_T, ARGON2_P]).toEqual([65536, 3, 1]);
    expect(authData).toMatchObject({ kdf: 'argon2id', m_kib: 65536, t: 3, p: 1 });
    expect(fromB64u(authData.salt)).toHaveLength(16);
    expect(fromB64u(authData.iv)).toHaveLength(12);
    for (const v of [authData.salt, authData.iv, authData.wrapped_key, authData.key_check]) {
      expect(v).not.toMatch(/=/); // unpadded base64
    }
    expect(backupKey).toHaveLength(32);
    expect(JSON.stringify(authData).length).toBeLessThan(4096);
  });

  it('unwraps with the right passphrase, and tells a wrong passphrase from corrupt data', async () => {
    const { authData, backupKey } = await createAuthData(
      'correct horse battery staple',
      fakeArgon2id,
    );
    expect(await unlockAuthData(authData, 'correct horse battery staple', fakeArgon2id)).toEqual(
      backupKey,
    );
    await expect(unlockAuthData(authData, 'wrong horse', fakeArgon2id)).rejects.toMatchObject({
      code: 'WRONG_PASSPHRASE',
    });
    const damaged = { ...authData, wrapped_key: toB64u(new Uint8Array(48)) };
    await expect(
      unlockAuthData(damaged, 'correct horse battery staple', fakeArgon2id),
    ).rejects.toMatchObject({
      code: 'CORRUPT',
    });
    await expect(unlockAuthData({ kdf: 'pbkdf2' }, 'x', fakeArgon2id)).rejects.toBeInstanceOf(
      BackupError,
    );
  });

  it('refuses parameters weaker than ours, so a server cannot downgrade the KDF', async () => {
    const { authData } = await createAuthData('p', fakeArgon2id);
    await expect(
      unlockAuthData({ ...authData, m_kib: 1024 }, 'p', fakeArgon2id),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(unlockAuthData({ ...authData, t: 1 }, 'p', fakeArgon2id)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('seals sessions with AES-256-GCM under the backup key and detects tampering', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealSession(key, { v: 1, pickle: 'PICKLE', sender_key: 'SENDER' });
    expect(await openSession(key, sealed)).toEqual({
      v: 1,
      pickle: 'PICKLE',
      sender_key: 'SENDER',
    });
    const bytes = fromB64u(sealed);
    bytes[20] = bytes[20]! ^ 1;
    await expect(openSession(key, toB64u(bytes))).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(
      openSession(crypto.getRandomValues(new Uint8Array(32)), sealed),
    ).rejects.toMatchObject({
      code: 'CORRUPT',
    });
  });

  it('runs the real libsodium Argon2id in this environment (WASM loads, 32 bytes, salt-dependent)', async () => {
    const salt = new Uint8Array(16).fill(7);
    const params = { mKib: ARGON2_M_KIB, t: ARGON2_T, p: ARGON2_P };
    const a = await libsodiumArgon2id('mật khẩu khôi phục', salt, params);
    const b = await libsodiumArgon2id('mật khẩu khôi phục', salt, params);
    const c = await libsodiumArgon2id('mật khẩu khôi phục', new Uint8Array(16).fill(8), params);
    expect(a).toHaveLength(32);
    expect(toB64u(a)).toBe(toB64u(b));
    expect(toB64u(a)).not.toBe(toB64u(c));
  }, 60_000);

  it('generates 5-word passphrases from the 1 296-word EFF list, and checks own passphrases', async () => {
    expect(EFF_SHORT_WORDLIST).toHaveLength(1296);
    expect(new Set(EFF_SHORT_WORDLIST).size).toBe(1296);
    const phrase = generatePassphrase(EFF_SHORT_WORDLIST);
    const words = phrase.split(' ');
    expect(words).toHaveLength(5);
    for (const w of words) expect(EFF_SHORT_WORDLIST).toContain(w);
    expect(generatePassphrase(EFF_SHORT_WORDLIST)).not.toBe(phrase);

    expect((await checkOwnPassphrase('short')).ok).toBe(false);
    expect((await checkOwnPassphrase('password1234')).ok).toBe(false);
    expect((await checkOwnPassphrase('Hồ Gươm lúc 5 giờ sáng có sương mù')).ok).toBe(true);
  });
});

describe('SOC-3b key backup: engine export/import across devices', () => {
  let wasm: Buffer;
  beforeAll(() => {
    wasm = fs.readFileSync(path.resolve(__dirname, '../../public/wasm/vodozemac_winkey_bg.wasm'));
  });

  it('a new device restores the backup and reads an old message; better local keys are kept', async () => {
    const phone = new E2eeWorkerEngine(new MemoryE2eeStorage(), fakeArgon2id);
    const reg = await phone.initSession('user-alice', wasm);
    const conv = 'conv-backup-1';
    const prep = await phone.prepareOutboundMegolm({
      conversationId: conv,
      memberDevices: [
        {
          userId: 'user-alice',
          deviceId: reg.deviceId,
          curve25519: reg.curve25519Key,
          ed25519: reg.ed25519Key,
        },
      ],
      claimedKeys: {},
    });
    const old = await phone.encryptMessage(
      conv,
      JSON.stringify({ type: 'text', body: 'Tin cũ trước khi đổi máy' }),
    );

    const { authData } = await phone.backupCreate('năm từ khoá khôi phục rất dài');
    await phone.backupActivate(1);
    expect(await phone.backupStatus()).toMatchObject({
      unlocked: true,
      version: 1,
      sessionCount: 1,
      backedUpCount: 0,
    });
    const pending = await phone.backupExportPending(100);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      conversation_id: conv,
      session_id: prep.sessionId,
      first_message_index: 0,
    });
    expect(pending[0]!.ciphertext.length).toBeLessThanOrEqual(10924);
    await phone.backupMarkUploaded([pending[0]!.key], 1);
    expect(await phone.backupExportPending(100)).toHaveLength(0);
    expect((await phone.backupStatus()).backedUpCount).toBe(1);

    // A fresh browser: no keys, so the old message waits for keys.
    const laptop = new E2eeWorkerEngine(new MemoryE2eeStorage(), fakeArgon2id);
    await laptop.initSession('user-alice', wasm);
    expect((await laptop.decryptGroupMessage(conv, prep.sessionId, old.ciphertext)).status).toBe(
      'WAITING_FOR_KEY',
    );

    await expect(laptop.backupUnlock(authData, 'sai mật khẩu')).rejects.toMatchObject({
      code: 'WRONG_PASSPHRASE',
    });
    await laptop.backupUnlock(authData, 'năm từ khoá khôi phục rất dài');
    await laptop.backupActivate(1);
    const items = pending.map(({ key: _key, ...rest }) => rest);
    expect(await laptop.backupImport(items)).toEqual({ imported: 1, kept: 0, failed: 0 });
    const dec = await laptop.decryptGroupMessage(conv, prep.sessionId, old.ciphertext);
    expect(dec).toMatchObject({ status: 'DECRYPTED' });
    expect(JSON.parse((dec as { plaintext: string }).plaintext).body).toBe(
      'Tin cũ trước khi đổi máy',
    );
    // Imported sessions count as backed up: nothing to re-upload.
    expect(await laptop.backupExportPending(100)).toHaveLength(0);

    // Importing again keeps the local copy (same first index); a garbled item fails alone.
    expect(await laptop.backupImport([...items, { ...items[0]!, ciphertext: 'AAAA' }])).toEqual({
      imported: 0,
      kept: 1,
      failed: 1,
    });

    await laptop.backupForget();
    expect((await laptop.backupStatus()).unlocked).toBe(false);
    await expect(laptop.backupExportPending(10)).rejects.toMatchObject({ code: 'LOCKED' });
  }, 60_000);
});

describe('SOC-3b key backup: upload batching and retries', () => {
  function fakeClient(pendingCount: number) {
    let left = pendingCount;
    return {
      marked: [] as string[][],
      forgotten: false,
      backupStatus: vi.fn(async () => ({
        unlocked: true,
        version: 3,
        sessionCount: pendingCount,
        backedUpCount: 0,
      })),
      backupExportPending: vi.fn(async (limit: number) => {
        const n = Math.min(limit, left);
        left -= n;
        return Array.from({ length: n }, (_, i) => ({
          key: `k${left + i}`,
          conversation_id: '0192f5e4-7c1a-7b3e-9d2a-00000000c001',
          session_id: `s${left + i}`,
          first_message_index: 0,
          ciphertext: 'QUJD',
        }));
      }),
      async backupMarkUploaded(keys: string[]) {
        this.marked.push(keys);
      },
      async backupForget() {
        this.forgotten = true;
      },
    };
  }

  it('uploads 250 sessions as 100 + 100 + 50, retrying a 503 with backoff', async () => {
    apiChat.PUT.mockReset();
    apiChat.PUT.mockResolvedValueOnce({
      data: undefined,
      error: {},
      response: new Response(null, { status: 503 }),
    });
    apiChat.PUT.mockResolvedValue({
      data: { stored: 1, kept: 0 },
      response: new Response(null, { status: 200 }),
    });
    const client = fakeClient(250);
    const delays: number[] = [];
    const service = new KeyBackupService(client as never, async (ms) => {
      delays.push(ms);
    });
    expect(await service.uploadPending()).toBe(250);
    const sizes = apiChat.PUT.mock.calls.map((c) => c[1].body.sessions.length);
    expect(sizes).toEqual([100, 100, 100, 50]); // the first 100 twice: 503, then retried
    expect(apiChat.PUT.mock.calls.every((c) => c[1].body.version === 3)).toBe(true);
    expect(delays).toEqual([1000]);
    expect(client.marked.map((k) => k.length)).toEqual([100, 100, 50]);
  });

  it('forgets a stale key when another device replaced the backup', async () => {
    apiChat.PUT.mockReset();
    apiChat.PUT.mockResolvedValue({
      data: undefined,
      error: { code: 'BACKUP_VERSION_MISMATCH' },
      response: new Response(null, { status: 409 }),
    });
    const client = fakeClient(5);
    const service = new KeyBackupService(client as never, async () => {});
    await expect(service.uploadPending()).rejects.toMatchObject({
      code: 'BACKUP_VERSION_MISMATCH',
    });
    expect(client.forgotten).toBe(true);
    expect(client.marked).toEqual([]);
  });
});
