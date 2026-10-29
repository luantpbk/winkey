import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  canonicalJson,
  decodeUnpaddedBase64,
  encodeUnpaddedBase64,
  verifyEd25519Canonical,
  verifyDeviceRegistrationSignature,
  verifySignedKeySignature,
} from '../../src/crypto/canonical-ed25519.js';
import { generateTestDeviceKeys, generateTestOneTimeKeys } from '../fixtures/keys.js';

describe('Ed25519 Canonical Cryptographic Verification (RFC 8785)', () => {
  it('formats canonical JSON with sorted keys and no whitespace', () => {
    const raw = {
      z: 100,
      a: 'hello',
      m: {
        y: true,
        x: null,
        nested: {
          b: 2,
          a: 1,
        },
      },
      arr: [3, 1, 2],
    };

    const expected =
      '{"a":"hello","arr":[3,1,2],"m":{"nested":{"a":1,"b":2},"x":null,"y":true},"z":100}';
    expect(canonicalJson(raw)).toBe(expected);
  });

  it('correctly decodes unpadded base64 and rejects padded or malformed inputs', () => {
    const random32 = crypto.randomBytes(32);
    const validB64 = encodeUnpaddedBase64(random32);
    expect(validB64.length).toBe(43);
    expect(validB64).not.toContain('=');

    // Valid decode
    const decoded = decodeUnpaddedBase64(validB64, 32);
    expect(decoded).not.toBeNull();
    expect(decoded!.equals(random32)).toBe(true);

    // Rejects if padded with '='
    expect(decodeUnpaddedBase64(validB64 + '=', 32)).toBeNull();

    // Rejects if incorrect length
    expect(decodeUnpaddedBase64(validB64.slice(0, 42), 32)).toBeNull();
    expect(decodeUnpaddedBase64(validB64 + 'A', 32)).toBeNull();

    // Rejects if invalid characters
    expect(decodeUnpaddedBase64(validB64.slice(0, 42) + '$', 32)).toBeNull();
  });

  it('verifies valid Ed25519 signature and rejects tampered messages', () => {
    const edPair = crypto.generateKeyPairSync('ed25519');
    const pubRaw = edPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    const pubB64 = encodeUnpaddedBase64(pubRaw);

    const payload = {
      action: 'transfer',
      amount: 1000,
      recipient: 'alice',
    };
    const cJson = canonicalJson(payload);
    const sigRaw = crypto.sign(null, Buffer.from(cJson, 'utf8'), edPair.privateKey);
    const sigB64 = encodeUnpaddedBase64(sigRaw);

    // Valid
    expect(verifyEd25519Canonical(pubB64, payload, sigB64)).toBe(true);

    // Tampered payload
    expect(verifyEd25519Canonical(pubB64, { ...payload, amount: 2000 }, sigB64)).toBe(false);

    // Wrong public key
    const otherEdPair = crypto.generateKeyPairSync('ed25519');
    const otherPubRaw = otherEdPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    const otherPubB64 = encodeUnpaddedBase64(otherPubRaw);
    expect(verifyEd25519Canonical(otherPubB64, payload, sigB64)).toBe(false);

    // Corrupted signature
    const corruptedSig = (sigB64[0] === 'A' ? 'B' : 'A') + sigB64.slice(1);
    expect(verifyEd25519Canonical(pubB64, payload, corruptedSig)).toBe(false);
  });

  it('verifies device registration signatures according to contract canonical specification', () => {
    const dev = generateTestDeviceKeys(
      '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
      '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
    );

    // Valid registration
    expect(
      verifyDeviceRegistrationSignature(
        dev.deviceId,
        dev.userId,
        dev.curve25519Key,
        dev.ed25519Key,
        dev.signature,
      ),
    ).toBe(true);

    // Tampered deviceId
    expect(
      verifyDeviceRegistrationSignature(
        '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c99',
        dev.userId,
        dev.curve25519Key,
        dev.ed25519Key,
        dev.signature,
      ),
    ).toBe(false);

    // Tampered userId
    expect(
      verifyDeviceRegistrationSignature(
        dev.deviceId,
        '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c99',
        dev.curve25519Key,
        dev.ed25519Key,
        dev.signature,
      ),
    ).toBe(false);

    // Tampered curve25519Key
    const otherX = crypto.generateKeyPairSync('x25519');
    const otherXPub = encodeUnpaddedBase64(
      otherX.publicKey.export({ format: 'der', type: 'spki' }).subarray(12),
    );
    expect(
      verifyDeviceRegistrationSignature(
        dev.deviceId,
        dev.userId,
        otherXPub,
        dev.ed25519Key,
        dev.signature,
      ),
    ).toBe(false);
  });

  it('verifies one-time keys and fallback keys with fallback boolean discriminator', () => {
    const dev = generateTestDeviceKeys(
      '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
      '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
    );

    // Fallback key
    expect(dev.fallbackKey).toBeDefined();
    expect(
      verifySignedKeySignature(
        dev.deviceId,
        dev.fallbackKey!.key_id,
        dev.fallbackKey!.public_key,
        dev.fallbackKey!.signature,
        dev.ed25519Key,
        true,
      ),
    ).toBe(true);

    // Fallback key verified as non-fallback must fail
    expect(
      verifySignedKeySignature(
        dev.deviceId,
        dev.fallbackKey!.key_id,
        dev.fallbackKey!.public_key,
        dev.fallbackKey!.signature,
        dev.ed25519Key,
        false,
      ),
    ).toBe(false);

    // One-time key
    const otks = generateTestOneTimeKeys(dev, 1);
    const otk = otks[0];

    expect(
      verifySignedKeySignature(
        dev.deviceId,
        otk.key_id,
        otk.public_key,
        otk.signature,
        dev.ed25519Key,
        false,
      ),
    ).toBe(true);

    // OTK verified as fallback must fail
    expect(
      verifySignedKeySignature(
        dev.deviceId,
        otk.key_id,
        otk.public_key,
        otk.signature,
        dev.ed25519Key,
        true,
      ),
    ).toBe(false);
  });
});
