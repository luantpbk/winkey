import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { E2eeWorkerEngine } from '../../src/lib/e2ee/engine';
import { E2eeStorage, type E2eeInboundGroupSessionRecord } from '../../src/lib/e2ee/storage';

// Memory storage mock for in-memory E2EE engine testing
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

describe('Megolm Self-Inbound Session & Device-List Rotation (ADR-049 / SOC-3a / PR #521)', () => {
  let wasmBytes: Buffer;

  beforeAll(() => {
    const wasmPath = path.resolve(__dirname, '../../public/wasm/vodozemac_winkey_bg.wasm');
    wasmBytes = fs.readFileSync(wasmPath);
  });

  describe('Self-inbound session creation & own message decryption', () => {
    it('creates inbound_group_sessions record for sender and allows sender to decrypt own messages', async () => {
      const aliceStorage = new MemoryE2eeStorage();
      const aliceEngine = new E2eeWorkerEngine(aliceStorage);
      const bobStorage = new MemoryE2eeStorage();
      const bobEngine = new E2eeWorkerEngine(bobStorage);

      const aliceReg = await aliceEngine.initSession('user-alice-1', wasmBytes);
      const bobReg = await bobEngine.initSession('user-bob-2', wasmBytes);

      const conversationId = 'conv-self-inbound-test';

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
      ];

      const claimedKeys = {
        [bobReg.deviceId]: {
          keyId: bobReg.oneTimeKeys[0].key_id,
          publicKey: bobReg.oneTimeKeys[0].public_key,
        },
      };

      // Alice prepares outbound Megolm
      const prepResult = await aliceEngine.prepareOutboundMegolm({
        conversationId,
        memberDevices,
        claimedKeys,
      });

      expect(prepResult.sessionId).toBeTruthy();
      expect(prepResult.toDeviceMessages.length).toBe(1);

      // Verify self-inbound session was written to storage
      const selfInboundKey = `${conversationId}:${prepResult.sessionId}`;
      const selfInboundRec = await aliceStorage.get<E2eeInboundGroupSessionRecord>(
        'inbound_group_sessions',
        selfInboundKey,
      );

      expect(selfInboundRec).not.toBeNull();
      expect(selfInboundRec?.conversation_id).toBe(conversationId);
      expect(selfInboundRec?.session_id).toBe(prepResult.sessionId);
      expect(selfInboundRec?.sender_key).toBe(aliceReg.curve25519Key);

      // Alice encrypts a message
      const plaintext = JSON.stringify({ type: 'text', body: 'Tin nhắn tự gửi và tự đọc' });
      const encResult = await aliceEngine.encryptMessage(conversationId, plaintext);

      expect(encResult.megolmSessionId).toBe(prepResult.sessionId);
      expect(encResult.ciphertext).toBeTruthy();

      // Alice decrypts her own message using decryptGroupMessage!
      const aliceDecrypted = await aliceEngine.decryptGroupMessage(
        conversationId,
        encResult.megolmSessionId,
        encResult.ciphertext,
      );

      expect(aliceDecrypted.status).toBe('DECRYPTED');
      if (aliceDecrypted.status === 'DECRYPTED') {
        expect(aliceDecrypted.plaintext).toBe(plaintext);
        expect(aliceDecrypted.messageIndex).toBe(0);
      }

      // Also Bob receives to-device message and decrypts the same message
      const bobToDeviceMsg = prepResult.toDeviceMessages[0];
      await bobEngine.decryptToDeviceBatch([
        {
          id: 'bob-td-1',
          senderId: 'user-alice-1',
          senderDeviceId: aliceReg.deviceId,
          senderCurve25519: aliceReg.curve25519Key,
          ciphertext: bobToDeviceMsg.ciphertext,
        },
      ]);

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
    });
  });

  describe('Megolm rotation on target device-list change', () => {
    it('reuses session when member device list is identical, but rotates when devices are added or removed', async () => {
      const aliceStorage = new MemoryE2eeStorage();
      const aliceEngine = new E2eeWorkerEngine(aliceStorage);

      const bobStorage1 = new MemoryE2eeStorage();
      const bobEngine1 = new E2eeWorkerEngine(bobStorage1);

      const bobStorage2 = new MemoryE2eeStorage();
      const bobEngine2 = new E2eeWorkerEngine(bobStorage2);

      const aliceReg = await aliceEngine.initSession('user-alice-1', wasmBytes);
      const bobReg1 = await bobEngine1.initSession('user-bob-2', wasmBytes);
      const bobReg2 = await bobEngine2.initSession('user-bob-2', wasmBytes);

      const conversationId = 'conv-rotation-devices-test';

      const initialMemberDevices = [
        {
          userId: 'user-alice-1',
          deviceId: aliceReg.deviceId,
          curve25519: aliceReg.curve25519Key,
          ed25519: aliceReg.ed25519Key,
        },
        {
          userId: 'user-bob-2',
          deviceId: bobReg1.deviceId,
          curve25519: bobReg1.curve25519Key,
          ed25519: bobReg1.ed25519Key,
        },
      ];

      const claimedKeys = {
        [bobReg1.deviceId]: {
          keyId: bobReg1.oneTimeKeys[0].key_id,
          publicKey: bobReg1.oneTimeKeys[0].public_key,
        },
        [bobReg2.deviceId]: {
          keyId: bobReg2.oneTimeKeys[0].key_id,
          publicKey: bobReg2.oneTimeKeys[0].public_key,
        },
      };

      // 1. Initial Megolm session creation (Session 1)
      const res1 = await aliceEngine.prepareOutboundMegolm({
        conversationId,
        memberDevices: initialMemberDevices,
        claimedKeys,
      });

      const session1Id = res1.sessionId;
      expect(session1Id).toBeTruthy();
      expect(res1.toDeviceMessages.length).toBe(1);
      expect(res1.toDeviceMessages[0].deviceId).toBe(bobReg1.deviceId);

      // 2. Calling again with unchanged device list: reuses Session 1, no to-device messages generated
      const res2 = await aliceEngine.prepareOutboundMegolm({
        conversationId,
        memberDevices: initialMemberDevices,
        claimedKeys,
      });

      expect(res2.sessionId).toBe(session1Id);
      expect(res2.toDeviceMessages.length).toBe(0);

      // 3. Bob registers a new device (Bob device 2) -> targetDevicesChanged triggered
      const memberDevicesWithBob2 = [
        ...initialMemberDevices,
        {
          userId: 'user-bob-2',
          deviceId: bobReg2.deviceId,
          curve25519: bobReg2.curve25519Key,
          ed25519: bobReg2.ed25519Key,
        },
      ];

      const res3 = await aliceEngine.prepareOutboundMegolm({
        conversationId,
        memberDevices: memberDevicesWithBob2,
        claimedKeys,
      });

      const session2Id = res3.sessionId;
      expect(session2Id).not.toBe(session1Id); // Session rotated!
      expect(res3.toDeviceMessages.length).toBe(2); // Dispatched to both of Bob's devices
      expect(res3.toDeviceMessages.map((m) => m.deviceId).sort()).toEqual(
        [bobReg1.deviceId, bobReg2.deviceId].sort(),
      );

      // 4. Calling again with same 2 Bob devices: reuses Session 2
      const res4 = await aliceEngine.prepareOutboundMegolm({
        conversationId,
        memberDevices: memberDevicesWithBob2,
        claimedKeys,
      });

      expect(res4.sessionId).toBe(session2Id);
      expect(res4.toDeviceMessages.length).toBe(0);

      // 5. Bob revokes device 1 -> targetDevicesChanged triggered (device removed)
      const memberDevicesOnlyBob2 = [
        {
          userId: 'user-alice-1',
          deviceId: aliceReg.deviceId,
          curve25519: aliceReg.curve25519Key,
          ed25519: aliceReg.ed25519Key,
        },
        {
          userId: 'user-bob-2',
          deviceId: bobReg2.deviceId,
          curve25519: bobReg2.curve25519Key,
          ed25519: bobReg2.ed25519Key,
        },
      ];

      const res5 = await aliceEngine.prepareOutboundMegolm({
        conversationId,
        memberDevices: memberDevicesOnlyBob2,
        claimedKeys,
      });

      const session3Id = res5.sessionId;
      expect(session3Id).not.toBe(session2Id); // Session rotated!
      expect(res5.toDeviceMessages.length).toBe(1);
      expect(res5.toDeviceMessages[0].deviceId).toBe(bobReg2.deviceId);
    });

    it('rotates Megolm session when another device for the same sender is added to the conversation', async () => {
      const aliceStorage1 = new MemoryE2eeStorage();
      const aliceEngine1 = new E2eeWorkerEngine(aliceStorage1);

      const aliceStorage2 = new MemoryE2eeStorage();
      const aliceEngine2 = new E2eeWorkerEngine(aliceStorage2);

      const bobStorage = new MemoryE2eeStorage();
      const bobEngine = new E2eeWorkerEngine(bobStorage);

      const aliceReg1 = await aliceEngine1.initSession('user-alice-1', wasmBytes);
      const aliceReg2 = await aliceEngine2.initSession('user-alice-1', wasmBytes);
      const bobReg = await bobEngine.initSession('user-bob-2', wasmBytes);

      const conversationId = 'conv-alice-multi-dev';

      const initialDevices = [
        {
          userId: 'user-alice-1',
          deviceId: aliceReg1.deviceId,
          curve25519: aliceReg1.curve25519Key,
          ed25519: aliceReg1.ed25519Key,
        },
        {
          userId: 'user-bob-2',
          deviceId: bobReg.deviceId,
          curve25519: bobReg.curve25519Key,
          ed25519: bobReg.ed25519Key,
        },
      ];

      const claimedKeys = {
        [bobReg.deviceId]: {
          keyId: bobReg.oneTimeKeys[0].key_id,
          publicKey: bobReg.oneTimeKeys[0].public_key,
        },
        [aliceReg2.deviceId]: {
          keyId: aliceReg2.oneTimeKeys[0].key_id,
          publicKey: aliceReg2.oneTimeKeys[0].public_key,
        },
      };

      // Alice 1 creates session 1
      const res1 = await aliceEngine1.prepareOutboundMegolm({
        conversationId,
        memberDevices: initialDevices,
        claimedKeys,
      });

      const s1 = res1.sessionId;
      expect(res1.toDeviceMessages.length).toBe(1);
      expect(res1.toDeviceMessages[0].deviceId).toBe(bobReg.deviceId);

      // Alice registers a second device (Alice 2)
      const devicesWithAlice2 = [
        ...initialDevices,
        {
          userId: 'user-alice-1',
          deviceId: aliceReg2.deviceId,
          curve25519: aliceReg2.curve25519Key,
          ed25519: aliceReg2.ed25519Key,
        },
      ];

      const res2 = await aliceEngine1.prepareOutboundMegolm({
        conversationId,
        memberDevices: devicesWithAlice2,
        claimedKeys,
      });

      // Target devices for Alice 1 now includes Alice 2 and Bob!
      expect(res2.sessionId).not.toBe(s1);
      expect(res2.toDeviceMessages.length).toBe(2);
      expect(res2.toDeviceMessages.map((m) => m.deviceId).sort()).toEqual(
        [aliceReg2.deviceId, bobReg.deviceId].sort(),
      );
    });
  });
});
