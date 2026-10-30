import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import init, {
  Account,
  GroupSession,
  InboundGroupSession,
  verifyEd25519Signature,
} from '../../e2ee-wasm/pkg/vodozemac_winkey.js';
import { buildDeviceKeysPayload, buildOneTimeKeyPayload } from '../../src/lib/e2ee/canonical';

describe('Vodozemac WASM bindings & E2EE cryptographic primitives (SOC-3a)', () => {
  beforeAll(async () => {
    const wasmPath = path.resolve(__dirname, '../../public/wasm/vodozemac_winkey_bg.wasm');
    const wasmBytes = fs.readFileSync(wasmPath);
    await init({ module_or_path: wasmBytes });
  });

  it('creates an account and produces 43-char unpadded base64 curve25519 & ed25519 keys', () => {
    const account = new Account();
    const curveKey = account.curve25519Key();
    const edKey = account.ed25519Key();

    expect(curveKey).toMatch(/^[A-Za-z0-9+/]{43}$/);
    expect(edKey).toMatch(/^[A-Za-z0-9+/]{43}$/);

    const identityKeys = JSON.parse(account.identityKeys());
    expect(identityKeys.curve25519).toBe(curveKey);
    expect(identityKeys.ed25519).toBe(edKey);
  });

  it('signs canonical device keys and one-time keys, and verifies with Ed25519', () => {
    const account = new Account();
    const curve25519 = account.curve25519Key();
    const ed25519 = account.ed25519Key();
    const deviceId = '018f3a5b-9d41-7e89-a1b2-c3d4e5f60001';
    const userId = '018f3a5b-9d41-7e89-a1b2-c3d4e5f60002';

    // 1. Device registration canonical signature
    const devicePayload = buildDeviceKeysPayload({
      userId,
      deviceId,
      curve25519,
      ed25519,
    });
    const deviceSig = account.sign(devicePayload);
    expect(deviceSig).toMatch(/^[A-Za-z0-9+/]{86}$/);

    // Verify valid signature
    const isValid = verifyEd25519Signature(ed25519, devicePayload, deviceSig);
    expect(isValid).toBe(true);

    // Tampered payload fails
    const tamperedPayload = devicePayload.replace(deviceId, '018f3a5b-9d41-7e89-a1b2-c3d4e5f69999');
    expect(verifyEd25519Signature(ed25519, tamperedPayload, deviceSig)).toBe(false);

    // Wrong public key fails
    const otherAccount = new Account();
    expect(verifyEd25519Signature(otherAccount.ed25519Key(), devicePayload, deviceSig)).toBe(false);

    // 2. One-time key signature
    account.generateOneTimeKeys(10);
    const otks = JSON.parse(account.oneTimeKeys()).curve25519;
    const [keyId, otkBase64] = Object.entries(otks)[0] as [string, string];

    const otkPayload = buildOneTimeKeyPayload({
      deviceId,
      keyId,
      key: otkBase64,
      fallback: false,
    });
    const otkSig = account.sign(otkPayload);
    expect(otkSig).toMatch(/^[A-Za-z0-9+/]{86}$/);
    expect(verifyEd25519Signature(ed25519, otkPayload, otkSig)).toBe(true);

    // 3. Fallback key signature
    account.generateFallbackKey();
    const fallbackData = JSON.parse(account.fallbackKey());
    expect(fallbackData).not.toBeNull();
    const fbPayload = buildOneTimeKeyPayload({
      deviceId,
      keyId: fallbackData.key_id,
      key: fallbackData.key,
      fallback: true,
    });
    const fbSig = account.sign(fbPayload);
    expect(fbSig).toMatch(/^[A-Za-z0-9+/]{86}$/);
    expect(verifyEd25519Signature(ed25519, fbPayload, fbSig)).toBe(true);
  });

  it('performs Olm 1-to-1 session roundtrip between Alice and Bob', () => {
    const alice = new Account();
    alice.generateOneTimeKeys(5);
    const aliceOtks = JSON.parse(alice.oneTimeKeys()).curve25519;
    const [_aliceKeyId, aliceOtk] = Object.entries(aliceOtks)[0] as [string, string];

    const bob = new Account();
    const bobSession = bob.createOutboundSession(alice.curve25519Key(), aliceOtk);

    // Bob encrypts first message (PreKey message type 0)
    const msg1Plaintext = 'Xin chào Alice từ Bob!';
    const enc1Json = bobSession.encrypt(msg1Plaintext);
    const msg1 = JSON.parse(enc1Json);
    expect(msg1.type).toBe(0); // PreKey

    // Alice creates inbound session and decrypts
    const aliceSession = alice.createInboundSession(bob.curve25519Key(), msg1.type, msg1.body);
    const dec1Bytes = aliceSession.decrypt(msg1.type, msg1.body);
    expect(new TextDecoder().decode(dec1Bytes)).toBe(msg1Plaintext);

    // Alice replies (subsequent message type 1)
    const msg2Plaintext = 'Chào Bob, mình nhận được tin nhắn rồi!';
    const enc2Json = aliceSession.encrypt(msg2Plaintext);
    const msg2 = JSON.parse(enc2Json);
    expect(msg2.type).toBe(1);

    const dec2Bytes = bobSession.decrypt(msg2.type, msg2.body);
    expect(new TextDecoder().decode(dec2Bytes)).toBe(msg2Plaintext);
  });

  it('performs Megolm group session roundtrip across multiple members', () => {
    // Alice creates an outbound Megolm group session
    const groupSession = new GroupSession();
    const sessionId = groupSession.sessionId();
    const sessionKey = groupSession.sessionKey();
    expect(sessionId).toBeTruthy();
    expect(sessionKey).toBeTruthy();
    expect(groupSession.messageIndex()).toBe(0);

    // Bob and Charlie import Alice's Megolm session key
    const bobInbound = new InboundGroupSession(sessionKey);
    const charlieInbound = new InboundGroupSession(sessionKey);
    expect(bobInbound.sessionId()).toBe(sessionId);
    expect(charlieInbound.sessionId()).toBe(sessionId);

    // Alice encrypts a message
    const msgPlaintext = JSON.stringify({ type: 'text', body: 'Chào cả nhóm!' });
    const ciphertext = groupSession.encrypt(msgPlaintext);
    expect(groupSession.messageIndex()).toBe(1);

    // Both Bob and Charlie decrypt the identical message
    const bobDecJson = bobInbound.decrypt(ciphertext);
    const bobDec = JSON.parse(bobDecJson);
    expect(new TextDecoder().decode(new Uint8Array(bobDec.plaintext))).toBe(msgPlaintext);
    expect(bobDec.message_index).toBe(0);

    const charlieDecJson = charlieInbound.decrypt(ciphertext);
    const charlieDec = JSON.parse(charlieDecJson);
    expect(new TextDecoder().decode(new Uint8Array(charlieDec.plaintext))).toBe(msgPlaintext);
    expect(charlieDec.message_index).toBe(0);
  });

  it('pickles and unpickles with 32-byte key, rejecting incorrect key', () => {
    const account = new Account();
    const correctKey = new Uint8Array(32).fill(7);
    const wrongKey = new Uint8Array(32).fill(9);

    const pickle = account.pickle(correctKey);
    expect(typeof pickle).toBe('string');

    // Restoring with correct key succeeds
    const restored = Account.fromPickle(pickle, correctKey);
    expect(restored.curve25519Key()).toBe(account.curve25519Key());
    expect(restored.ed25519Key()).toBe(account.ed25519Key());

    // Restoring with wrong key fails
    expect(() => Account.fromPickle(pickle, wrongKey)).toThrow();
  });
});
