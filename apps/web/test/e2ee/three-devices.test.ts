import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { E2eeWorkerEngine } from '../../src/lib/e2ee/engine';
import { E2eeStorage } from '../../src/lib/e2ee/storage';

// Memory storage mock for Node testing of multi-device scenarios
class MemoryE2eeStorage extends E2eeStorage {
  private stores = new Map<string, Map<any, any>>();

  async open(): Promise<IDBDatabase> {
    return {} as any;
  }

  private getStore(name: string): Map<any, any> {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
    return this.stores.get(name)!;
  }

  async get<T>(storeName: string, key: any): Promise<T | null> {
    return this.getStore(storeName).get(key) ?? null;
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    return Array.from(this.getStore(storeName).values());
  }

  async put(storeName: string, value: any): Promise<void> {
    const key =
      value.key ?? value.id ?? value.peer_curve25519 ?? value.conversation_id ?? value.device_id;
    this.getStore(storeName).set(key, value);
  }

  async delete(storeName: string, key: any): Promise<void> {
    this.getStore(storeName).delete(key);
  }

  async clearStore(storeName: string): Promise<void> {
    this.getStore(storeName).clear();
  }

  close(): void {
    this.stores.clear();
  }
}

describe('Three-device E2EE round trip (Alice, Bob, Charlie) (ADR-049 / SOC-3a)', () => {
  let wasmBytes: Buffer;

  beforeAll(() => {
    const wasmPath = path.resolve(__dirname, '../../public/wasm/vodozemac_winkey_bg.wasm');
    wasmBytes = fs.readFileSync(wasmPath);
  });

  it('completes full registration, to-device distribution, and group message decryption across 3 devices', async () => {
    // 1. Initialize Alice, Bob, and Charlie engines with isolated storage
    const aliceEngine = new E2eeWorkerEngine(new MemoryE2eeStorage());
    const bobEngine = new E2eeWorkerEngine(new MemoryE2eeStorage());
    const charlieEngine = new E2eeWorkerEngine(new MemoryE2eeStorage());

    const aliceReg = await aliceEngine.initSession('user-alice-1', wasmBytes);
    const bobReg = await bobEngine.initSession('user-bob-2', wasmBytes);
    const charlieReg = await charlieEngine.initSession('user-charlie-3', wasmBytes);

    expect(aliceReg.isNewDevice).toBe(true);
    expect(bobReg.isNewDevice).toBe(true);
    expect(charlieReg.isNewDevice).toBe(true);
    expect(aliceReg.oneTimeKeys.length).toBe(50);
    expect(bobReg.oneTimeKeys.length).toBe(50);
    expect(charlieReg.oneTimeKeys.length).toBe(50);

    const conversationId = 'conv-group-abc';

    // 2. Alice prepares outbound Megolm session
    // She queries members' devices and claims 1 OTK per target device
    const memberDevices = [
      {
        userId: 'user-alice-1',
        deviceId: aliceReg.deviceId,
        curve25519: aliceReg.curve25519Key,
        ed25519: aliceReg.ed25519Key,
      },
      {
        userId: 'user-bob-2',
        deviceId: bobReg.deviceId,
        curve25519: bobReg.curve25519Key,
        ed25519: bobReg.ed25519Key,
      },
      {
        userId: 'user-charlie-3',
        deviceId: charlieReg.deviceId,
        curve25519: charlieReg.curve25519Key,
        ed25519: charlieReg.ed25519Key,
      },
    ];

    const claimedKeys = {
      [bobReg.deviceId]: {
        keyId: bobReg.oneTimeKeys[0].key_id,
        publicKey: bobReg.oneTimeKeys[0].public_key,
      },
      [charlieReg.deviceId]: {
        keyId: charlieReg.oneTimeKeys[0].key_id,
        publicKey: charlieReg.oneTimeKeys[0].public_key,
      },
    };

    const prepResult = await aliceEngine.prepareOutboundMegolm({
      conversationId,
      memberDevices,
      claimedKeys,
    });

    expect(prepResult.sessionId).toBeTruthy();
    expect(prepResult.toDeviceMessages.length).toBe(2); // One for Bob, one for Charlie

    // 3. Alice encrypts group message
    const plaintext = JSON.stringify({ type: 'text', body: 'Chào Bob và Charlie!' });
    const encResult = await aliceEngine.encryptMessage(conversationId, plaintext);
    expect(encResult.megolmSessionId).toBe(prepResult.sessionId);
    expect(encResult.ciphertext).toBeTruthy();
    expect(encResult.messageIndex).toBe(0);

    // 4. Bob receives his to-device message and decrypts it
    const bobToDeviceMsg = prepResult.toDeviceMessages.find((m) => m.deviceId === bobReg.deviceId)!;
    const bobToDeviceResult = await bobEngine.decryptToDeviceBatch([
      {
        id: 'td-msg-1',
        senderId: 'user-alice-1',
        senderDeviceId: aliceReg.deviceId,
        senderCurve25519: aliceReg.curve25519Key,
        ciphertext: bobToDeviceMsg.ciphertext,
      },
    ]);
    expect(bobToDeviceResult.processedIds).toEqual(['td-msg-1']);
    expect(bobToDeviceResult.newMegolmSessionIds).toEqual([prepResult.sessionId]);

    // Bob decrypts Alice's message!
    const bobDecrypted = await bobEngine.decryptGroupMessage(
      conversationId,
      encResult.megolmSessionId,
      encResult.ciphertext,
    );
    expect(bobDecrypted.status).toBe('DECRYPTED');
    if (bobDecrypted.status === 'DECRYPTED') {
      expect(bobDecrypted.plaintext).toBe(plaintext);
      expect(bobDecrypted.messageIndex).toBe(0);
    }

    // 5. Charlie before receiving to-device: status WAITING_FOR_KEY
    const charlieBeforeWait = await charlieEngine.decryptGroupMessage(
      conversationId,
      encResult.megolmSessionId,
      encResult.ciphertext,
    );
    expect(charlieBeforeWait.status).toBe('WAITING_FOR_KEY');

    // Charlie receives his to-device message
    const charlieToDeviceMsg = prepResult.toDeviceMessages.find(
      (m) => m.deviceId === charlieReg.deviceId,
    )!;
    const charlieToDeviceResult = await charlieEngine.decryptToDeviceBatch([
      {
        id: 'td-msg-2',
        senderId: 'user-alice-1',
        senderDeviceId: aliceReg.deviceId,
        senderCurve25519: aliceReg.curve25519Key,
        ciphertext: charlieToDeviceMsg.ciphertext,
      },
    ]);
    expect(charlieToDeviceResult.processedIds).toEqual(['td-msg-2']);

    // Now Charlie decrypts successfully
    const charlieDecrypted = await charlieEngine.decryptGroupMessage(
      conversationId,
      encResult.megolmSessionId,
      encResult.ciphertext,
    );
    expect(charlieDecrypted.status).toBe('DECRYPTED');
    if (charlieDecrypted.status === 'DECRYPTED') {
      expect(charlieDecrypted.plaintext).toBe(plaintext);
    }
  });
});
