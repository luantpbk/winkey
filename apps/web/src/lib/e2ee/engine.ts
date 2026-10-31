/**
 * E2EE Crypto Engine for Winkey (ADR-049 §5 / SOC-3a)
 *
 * Core cryptographic logic running inside Web Worker or test runner.
 * Never exposes unencrypted private pickles to the main thread.
 */

import initVodozemac, {
  Account,
  Session,
  GroupSession,
  InboundGroupSession,
} from '../../../e2ee-wasm/pkg/vodozemac_winkey.js';
import { buildDeviceKeysPayload, buildOneTimeKeyPayload } from './canonical';
import {
  generateMasterStorageKey,
  generateRandomPickleKey,
  wrapPickleKey,
  unwrapPickleKey,
  type WrappedPickleKey,
} from './pickle-key';
import {
  E2eeStorage,
  type E2eeOlmSessionRecord,
  type E2eeOutboundGroupSessionRecord,
  type E2eeInboundGroupSessionRecord,
  type E2eeDeviceTrustRecord,
} from './storage';
import { shouldRotateMegolmSession } from './rotation';
import type {
  MemberDeviceRef,
  ClaimedOtkRef,
  WorkerInitResult,
  WorkerPrepareMegolmResult,
  WorkerEncryptMessageResult,
  WorkerDecryptToDeviceResult,
  WorkerEncryptToDeviceResult,
  DecryptGroupMessageResult,
  TrustRecordStatus,
} from './protocol';

function toBase64(str: string): string {
  if (typeof btoa !== 'undefined') {
    return btoa(str);
  }
  return Buffer.from(str, 'utf8').toString('base64');
}

function fromBase64(b64: string): string {
  if (typeof atob !== 'undefined') {
    return atob(b64);
  }
  return Buffer.from(b64, 'base64').toString('utf8');
}

export class E2eeWorkerEngine {
  private storage: E2eeStorage;
  private account: Account | null = null;
  private pickleKey: Uint8Array | null = null;
  private masterKey: CryptoKey | null = null;
  private deviceId: string | null = null;
  private userId: string | null = null;
  private wasmInitialized = false;

  constructor(storage = new E2eeStorage()) {
    this.storage = storage;
  }

  async ensureWasm(wasmInput?: any): Promise<void> {
    if (this.wasmInitialized) return;

    if (wasmInput) {
      await initVodozemac({ module_or_path: wasmInput });
    } else if (typeof window === 'undefined' && typeof self === 'undefined') {
      // In Node environment without wasmInput provided, we load from public/wasm
      const fs = await import('node:fs');
      const path = await import('node:path');
      const wasmPath = path.resolve(process.cwd(), 'apps/web/public/wasm/vodozemac_winkey_bg.wasm');
      const wasmBytes = fs.readFileSync(wasmPath);
      await initVodozemac({ module_or_path: wasmBytes });
    } else {
      // In Web Worker / Browser environment
      await initVodozemac('/wasm/vodozemac_winkey_bg.wasm');
    }
    this.wasmInitialized = true;
  }

  async initSession(userId: string, wasmInput?: any): Promise<WorkerInitResult> {
    await this.ensureWasm(wasmInput);
    this.userId = userId;

    await this.storage.open();

    // 1. Load or initialize master WebCrypto AES-GCM storage key
    const masterKeyRec = await this.storage.get<{ key: string; value: CryptoKey }>(
      'meta',
      'master_key',
    );
    const wrappedPickleRec = await this.storage.get<{ key: string; value: WrappedPickleKey }>(
      'meta',
      'wrapped_pickle_key',
    );
    const deviceIdRec = await this.storage.get<{ key: string; value: string }>('meta', 'device_id');

    let isNewDevice = false;

    if (!masterKeyRec || !wrappedPickleRec || !deviceIdRec) {
      isNewDevice = true;
      this.masterKey = await generateMasterStorageKey();
      this.pickleKey = generateRandomPickleKey();
      const wrapped = await wrapPickleKey(this.masterKey, this.pickleKey);

      // Client generates device UUIDv7
      this.deviceId = crypto.randomUUID();

      await this.storage.put('meta', { key: 'master_key', value: this.masterKey });
      await this.storage.put('meta', { key: 'wrapped_pickle_key', value: wrapped });
      await this.storage.put('meta', { key: 'device_id', value: this.deviceId });
      await this.storage.put('meta', { key: 'user_id', value: userId });
    } else {
      this.masterKey = masterKeyRec.value;
      this.deviceId = deviceIdRec.value;
      this.pickleKey = await unwrapPickleKey(this.masterKey, wrappedPickleRec.value);
    }

    // 2. Load or create Vodozemac Account
    const accountRec = await this.storage.get<{ id: string; pickle: string }>('account', 'current');
    if (accountRec && !isNewDevice) {
      this.account = Account.fromPickle(accountRec.pickle, this.pickleKey);
      const curve25519Key = this.account.curve25519Key();
      const ed25519Key = this.account.ed25519Key();
      const canonical = buildDeviceKeysPayload({
        userId: this.userId,
        deviceId: this.deviceId,
        curve25519: curve25519Key,
        ed25519: ed25519Key,
      });
      const signature = this.account.sign(canonical);

      return {
        isNewDevice: false,
        deviceId: this.deviceId,
        curve25519Key,
        ed25519Key,
        signature,
        oneTimeKeys: [],
        fallbackKey: null,
      };
    }

    // New device: create account, generate 50 OTKs and 1 fallback key
    this.account = new Account();
    this.account.generateOneTimeKeys(50);
    this.account.generateFallbackKey();

    const curve25519Key = this.account.curve25519Key();
    const ed25519Key = this.account.ed25519Key();

    // Canonical device signature
    const canonical = buildDeviceKeysPayload({
      userId: this.userId,
      deviceId: this.deviceId,
      curve25519: curve25519Key,
      ed25519: ed25519Key,
    });
    const signature = this.account.sign(canonical);

    // Format & sign one-time keys
    const rawOtks = JSON.parse(this.account.oneTimeKeys()).curve25519 as Record<string, string>;
    const oneTimeKeys = Object.entries(rawOtks).map(([key_id, public_key]) => {
      const otkCanonical = buildOneTimeKeyPayload({
        deviceId: this.deviceId!,
        keyId: key_id,
        key: public_key,
        fallback: false,
      });
      return {
        key_id,
        public_key,
        signature: this.account!.sign(otkCanonical),
      };
    });

    // Format & sign fallback key
    const rawFallback = JSON.parse(this.account.fallbackKey()) as {
      key_id: string;
      key: string;
    } | null;
    let fallbackKey = null;
    if (rawFallback) {
      const fbCanonical = buildOneTimeKeyPayload({
        deviceId: this.deviceId!,
        keyId: rawFallback.key_id,
        key: rawFallback.key,
        fallback: true,
      });
      fallbackKey = {
        key_id: rawFallback.key_id,
        public_key: rawFallback.key,
        signature: this.account.sign(fbCanonical),
      };
    }

    // Persist account pickle in IndexedDB
    const accountPickle = this.account.pickle(this.pickleKey);
    await this.storage.put('account', {
      id: 'current',
      pickle: accountPickle,
      updated_at: new Date().toISOString(),
    });

    return {
      isNewDevice: true,
      deviceId: this.deviceId,
      curve25519Key,
      ed25519Key,
      signature,
      oneTimeKeys,
      fallbackKey,
    };
  }

  async generateOneTimeKeys(
    count: number,
  ): Promise<Array<{ key_id: string; public_key: string; signature: string }>> {
    if (!this.account || !this.pickleKey || !this.deviceId) {
      throw new Error('E2EE engine not initialized');
    }

    this.account.generateOneTimeKeys(count);
    const rawOtks = JSON.parse(this.account.oneTimeKeys()).curve25519 as Record<string, string>;

    const signedOtks = Object.entries(rawOtks).map(([key_id, public_key]) => {
      const otkCanonical = buildOneTimeKeyPayload({
        deviceId: this.deviceId!,
        keyId: key_id,
        key: public_key,
        fallback: false,
      });
      return {
        key_id,
        public_key,
        signature: this.account!.sign(otkCanonical),
      };
    });

    const accountPickle = this.account.pickle(this.pickleKey);
    await this.storage.put('account', {
      id: 'current',
      pickle: accountPickle,
      updated_at: new Date().toISOString(),
    });

    return signedOtks;
  }

  async markKeysPublished(): Promise<void> {
    if (!this.account || !this.pickleKey) {
      throw new Error('E2EE engine not initialized');
    }

    this.account.markKeysAsPublished();
    const accountPickle = this.account.pickle(this.pickleKey);
    await this.storage.put('account', {
      id: 'current',
      pickle: accountPickle,
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Prepares the outbound Megolm group session for a conversation.
   * If session does not exist or needs rotation, creates a new session
   * and generates Olm-encrypted to-device payloads for all member devices.
   */
  async prepareOutboundMegolm(params: {
    conversationId: string;
    memberDevices: MemberDeviceRef[];
    claimedKeys: Record<string, ClaimedOtkRef>;
    forceRotate?: boolean;
    devicesChanged?: boolean;
    membershipChanged?: boolean;
  }): Promise<WorkerPrepareMegolmResult> {
    if (!this.account || !this.pickleKey || !this.deviceId) {
      throw new Error('E2EE engine not initialized');
    }

    const {
      conversationId,
      memberDevices,
      claimedKeys,
      forceRotate,
      devicesChanged,
      membershipChanged,
    } = params;

    const existing = await this.storage.get<E2eeOutboundGroupSessionRecord>(
      'outbound_group_sessions',
      conversationId,
    );

    // Target devices: all member devices except our own active device
    const targetDevices = memberDevices.filter((d) => d.deviceId !== this.deviceId);
    const currentDeviceIds = targetDevices.map((d) => d.deviceId).sort();

    const prevDeviceIds = existing?.device_ids ? [...existing.device_ids].sort() : null;
    const targetDevicesChanged =
      !existing ||
      !prevDeviceIds ||
      currentDeviceIds.length !== prevDeviceIds.length ||
      currentDeviceIds.some((id, idx) => id !== prevDeviceIds[idx]);

    const rotationCheck = shouldRotateMegolmSession(
      existing
        ? {
            sessionId: existing.session_id,
            messageIndex: existing.message_index,
            createdAt: existing.created_at,
          }
        : null,
      {
        devicesChanged: devicesChanged || targetDevicesChanged,
        membershipChanged: membershipChanged || forceRotate,
      },
    );

    // If existing session is still valid and not rotated, return its sessionId
    if (existing && !rotationCheck.shouldRotate) {
      return {
        sessionId: existing.session_id,
        toDeviceMessages: [],
      };
    }

    // Create new Megolm outbound GroupSession
    const groupSession = new GroupSession();
    const sessionId = groupSession.sessionId();
    const sessionKey = groupSession.sessionKey();

    // Plaintext key distribution event for to-device payload
    const toDevicePlaintext = JSON.stringify({
      conversation_id: conversationId,
      session_id: sessionId,
      session_key: sessionKey,
    });

    const toDeviceMessages: Array<{ deviceId: string; ciphertext: string }> = [];

    for (const target of targetDevices) {
      // 1. Check existing 1-to-1 Olm session
      const olmRec = await this.storage.get<E2eeOlmSessionRecord>(
        'olm_sessions',
        target.curve25519,
      );
      let session: Session;

      if (olmRec) {
        session = Session.fromPickle(olmRec.pickle, this.pickleKey);
      } else {
        const claimed = claimedKeys[target.deviceId];
        if (!claimed) {
          // If no claimed key provided for this target, skip until claim is fetched
          continue;
        }
        session = this.account.createOutboundSession(target.curve25519, claimed.publicKey);
      }

      // Encrypt to-device payload under Olm
      const olmMsgJson = session.encrypt(toDevicePlaintext);
      // Contract: ciphertext is JSON {type, body} serialised, then base64
      const ciphertext = toBase64(olmMsgJson);
      toDeviceMessages.push({
        deviceId: target.deviceId,
        ciphertext,
      });

      // Save updated Olm session pickle
      const sessionPickle = session.pickle(this.pickleKey);
      await this.storage.put('olm_sessions', {
        peer_curve25519: target.curve25519,
        peer_device_id: target.deviceId,
        pickle: sessionPickle,
        updated_at: new Date().toISOString(),
      });
    }

    // Save outbound Megolm session
    const groupPickle = groupSession.pickle(this.pickleKey);
    await this.storage.put('outbound_group_sessions', {
      conversation_id: conversationId,
      session_id: sessionId,
      message_index: 0,
      created_at: Date.now(),
      pickle: groupPickle,
      device_ids: currentDeviceIds,
    });

    // Save corresponding InboundGroupSession so sender can decrypt own sent messages
    const selfInbound = new InboundGroupSession(sessionKey);
    const selfInboundPickle = selfInbound.pickle(this.pickleKey);
    await this.storage.put('inbound_group_sessions', {
      key: `${conversationId}:${sessionId}`,
      conversation_id: conversationId,
      session_id: sessionId,
      sender_key: this.account.curve25519Key(),
      pickle: selfInboundPickle,
      created_at: Date.now(),
    });

    return {
      sessionId,
      toDeviceMessages,
    };
  }

  /**
   * SOC-4a: Olm-encrypts an arbitrary event (call candidates, select_answer, negotiate) for each target device,
   * reusing the Olm session with that device or starting one from a claimed key. The plaintext is
   * `{"type":"winkey.event","event":…}` so the receiver never mistakes it for a Megolm key share.
   */
  async encryptToDevice(params: {
    targets: MemberDeviceRef[];
    claimedKeys: Record<string, ClaimedOtkRef>;
    event: unknown;
  }): Promise<WorkerEncryptToDeviceResult> {
    if (!this.account || !this.pickleKey) {
      throw new Error('E2EE engine not initialized');
    }
    const plaintext = JSON.stringify({ type: 'winkey.event', event: params.event });
    const messages: WorkerEncryptToDeviceResult['messages'] = [];
    const needKeys: string[] = [];
    for (const target of params.targets) {
      if (target.deviceId === this.deviceId) continue;
      const olmRec = await this.storage.get<E2eeOlmSessionRecord>(
        'olm_sessions',
        target.curve25519,
      );
      let session: Session;
      if (olmRec) {
        session = Session.fromPickle(olmRec.pickle, this.pickleKey);
      } else {
        const claimed = params.claimedKeys[target.deviceId];
        if (!claimed) {
          needKeys.push(target.deviceId);
          continue;
        }
        session = this.account.createOutboundSession(target.curve25519, claimed.publicKey);
      }
      messages.push({
        deviceId: target.deviceId,
        ciphertext: toBase64(session.encrypt(plaintext)),
      });
      await this.storage.put('olm_sessions', {
        peer_curve25519: target.curve25519,
        peer_device_id: target.deviceId,
        pickle: session.pickle(this.pickleKey),
        updated_at: new Date().toISOString(),
      });
    }
    return { messages, needKeys };
  }

  async encryptMessage(
    conversationId: string,
    plaintext: string,
  ): Promise<WorkerEncryptMessageResult> {
    if (!this.pickleKey) {
      throw new Error('E2EE engine not initialized');
    }

    const rec = await this.storage.get<E2eeOutboundGroupSessionRecord>(
      'outbound_group_sessions',
      conversationId,
    );
    if (!rec) {
      throw new Error(`No active outbound Megolm session found for conversation ${conversationId}`);
    }

    const groupSession = GroupSession.fromPickle(rec.pickle, this.pickleKey);
    const ciphertext = groupSession.encrypt(plaintext);
    const newIndex = groupSession.messageIndex();

    // Persist incremented messageIndex
    const updatedPickle = groupSession.pickle(this.pickleKey);
    await this.storage.put('outbound_group_sessions', {
      ...rec,
      message_index: newIndex,
      pickle: updatedPickle,
    });

    return {
      megolmSessionId: rec.session_id,
      ciphertext,
      messageIndex: newIndex - 1,
    };
  }

  /**
   * Decrypts pending to-device messages (Olm) and imports received Megolm session keys.
   */
  async decryptToDeviceBatch(
    messages: Array<{
      id: string;
      senderId: string;
      senderDeviceId: string;
      ciphertext: string;
      senderCurve25519?: string;
    }>,
  ): Promise<WorkerDecryptToDeviceResult> {
    if (!this.account || !this.pickleKey) {
      throw new Error('E2EE engine not initialized');
    }

    const processedIds: string[] = [];
    const newMegolmSessionIds: string[] = [];
    const events: NonNullable<WorkerDecryptToDeviceResult['events']> = [];

    for (const msg of messages) {
      try {
        const decodedJson = fromBase64(msg.ciphertext);
        const olmMsg = JSON.parse(decodedJson) as { type: number; body: string };

        // Determine sender curve25519 key (from record or message)
        const senderCurve = msg.senderCurve25519;
        if (!senderCurve) {
          // If sender curve not provided directly, skip or try stored session
          continue;
        }

        const olmRec = await this.storage.get<E2eeOlmSessionRecord>('olm_sessions', senderCurve);
        let session: Session;

        if (olmMsg.type === 0) {
          // PreKey message: create inbound Olm session
          session = this.account.createInboundSession(senderCurve, olmMsg.type, olmMsg.body);
        } else if (olmRec) {
          session = Session.fromPickle(olmRec.pickle, this.pickleKey);
        } else {
          // Type 1 without existing session cannot decrypt
          continue;
        }

        const decryptedBytes = session.decrypt(olmMsg.type, olmMsg.body);
        const payloadText = new TextDecoder().decode(decryptedBytes);
        const payload = JSON.parse(payloadText) as Record<string, unknown>;

        if (payload.type === 'winkey.event') {
          // SOC-4a: not a key share. Hand the event to the main thread (it validates it), keep the Olm state.
          events.push({
            senderId: msg.senderId,
            senderDeviceId: msg.senderDeviceId,
            event: payload.event,
          });
          await this.storage.put('olm_sessions', {
            peer_curve25519: senderCurve,
            peer_device_id: msg.senderDeviceId,
            pickle: session.pickle(this.pickleKey),
            updated_at: new Date().toISOString(),
          });
          await this.storage.put('account', {
            id: 'current',
            pickle: this.account.pickle(this.pickleKey),
            updated_at: new Date().toISOString(),
          });
          processedIds.push(msg.id);
          continue;
        }

        const keyData = payload as unknown as {
          conversation_id: string;
          session_id: string;
          session_key: string;
        };

        // Create InboundGroupSession from the received session_key
        const inbound = new InboundGroupSession(keyData.session_key);
        const inboundPickle = inbound.pickle(this.pickleKey);

        const compositeKey = `${keyData.conversation_id}:${keyData.session_id}`;
        await this.storage.put('inbound_group_sessions', {
          key: compositeKey,
          conversation_id: keyData.conversation_id,
          session_id: keyData.session_id,
          sender_key: senderCurve,
          pickle: inboundPickle,
          created_at: Date.now(),
        });

        // Save updated Olm session
        const sessionPickle = session.pickle(this.pickleKey);
        await this.storage.put('olm_sessions', {
          peer_curve25519: senderCurve,
          peer_device_id: msg.senderDeviceId,
          pickle: sessionPickle,
          updated_at: new Date().toISOString(),
        });

        // Also save account pickle (prekey consumption)
        const accountPickle = this.account.pickle(this.pickleKey);
        await this.storage.put('account', {
          id: 'current',
          pickle: accountPickle,
          updated_at: new Date().toISOString(),
        });

        processedIds.push(msg.id);
        newMegolmSessionIds.push(keyData.session_id);
      } catch (err) {
        console.warn(`[E2EE] Failed to decrypt to-device message ${msg.id}:`, err);
      }
    }

    return {
      processedIds,
      newMegolmSessionIds,
      events,
    };
  }

  async decryptGroupMessage(
    conversationId: string,
    megolmSessionId: string,
    ciphertext: string,
  ): Promise<DecryptGroupMessageResult> {
    if (!this.pickleKey) {
      throw new Error('E2EE engine not initialized');
    }

    const compositeKey = `${conversationId}:${megolmSessionId}`;
    const rec = await this.storage.get<E2eeInboundGroupSessionRecord>(
      'inbound_group_sessions',
      compositeKey,
    );

    if (!rec) {
      // Key hasn't arrived yet via to-device
      return { status: 'WAITING_FOR_KEY' };
    }

    try {
      const inbound = InboundGroupSession.fromPickle(rec.pickle, this.pickleKey);
      const decJson = inbound.decrypt(ciphertext);
      const decDto = JSON.parse(decJson) as { plaintext: number[]; message_index: number };
      const plaintext = new TextDecoder().decode(new Uint8Array(decDto.plaintext));

      // Save updated ratchet state
      const updatedPickle = inbound.pickle(this.pickleKey);
      await this.storage.put('inbound_group_sessions', {
        ...rec,
        pickle: updatedPickle,
      });

      return {
        status: 'DECRYPTED',
        plaintext,
        messageIndex: decDto.message_index,
      };
    } catch (err: any) {
      return {
        status: 'ERROR',
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Trust on first use (TOFU) check and record for peer devices.
   */
  async checkOrRecordDeviceTrust(params: {
    deviceId: string;
    userId: string;
    curve25519: string;
    ed25519: string;
  }): Promise<{ status: TrustRecordStatus; record: E2eeDeviceTrustRecord }> {
    const existing = await this.storage.get<E2eeDeviceTrustRecord>('device_trust', params.deviceId);

    if (!existing) {
      const record: E2eeDeviceTrustRecord = {
        device_id: params.deviceId,
        user_id: params.userId,
        curve25519_key: params.curve25519,
        ed25519_key: params.ed25519,
        first_seen_at: new Date().toISOString(),
        verified: false,
      };
      await this.storage.put('device_trust', record);
      return { status: 'NEW_DEVICE', record };
    }

    if (existing.curve25519_key !== params.curve25519 || existing.ed25519_key !== params.ed25519) {
      return { status: 'KEY_CHANGED', record: existing };
    }

    return { status: 'TRUSTED', record: existing };
  }

  async wipeDatabase(): Promise<void> {
    this.storage.close();
    await E2eeStorage.wipeDatabase();
    this.account = null;
    this.pickleKey = null;
    this.masterKey = null;
    this.deviceId = null;
    this.userId = null;
  }
}
