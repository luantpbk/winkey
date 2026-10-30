import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import init, { Account } from '../../e2ee-wasm/pkg/vodozemac_winkey.js';
import { buildDeviceKeysPayload, buildOneTimeKeyPayload } from '../../src/lib/e2ee/canonical';

function toBase64Padded(unpadded: string): string {
  while (unpadded.length % 4 !== 0) {
    unpadded += '=';
  }
  return unpadded;
}

function verifyWithNodeCrypto(
  ed25519KeyBase64: string,
  message: string,
  sigBase64: string,
): boolean {
  const rawKey = Buffer.from(toBase64Padded(ed25519KeyBase64), 'base64');
  expect(rawKey.length).toBe(32);

  // DER SPKI header for Ed25519: 302a300506032b6570032100 (12 bytes) + 32 raw bytes
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const spkiBuffer = Buffer.concat([spkiPrefix, rawKey]);

  const publicKey = crypto.createPublicKey({
    key: spkiBuffer,
    format: 'der',
    type: 'spki',
  });

  const rawSig = Buffer.from(toBase64Padded(sigBase64), 'base64');
  expect(rawSig.length).toBe(64);

  return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, rawSig);
}

describe('Generate and verify signed key fixtures for AG3 (SOC-3a)', () => {
  beforeAll(async () => {
    const wasmPath = path.resolve(__dirname, '../../public/wasm/vodozemac_winkey_bg.wasm');
    const wasmBytes = fs.readFileSync(wasmPath);
    await init({ module_or_path: wasmBytes });
  });

  it('generates 3 complete device key fixtures and verifies with Node crypto SPKI', () => {
    const devicesData = [
      {
        user_id: '0192df40-7e12-7000-8000-000000000001',
        device_id: '0192df40-7e12-7000-8000-00000000000a',
        display_name: 'Chrome trên Windows (Desktop)',
      },
      {
        user_id: '0192df40-7e12-7000-8000-000000000002',
        device_id: '0192df40-7e12-7000-8000-00000000000b',
        display_name: 'Safari trên iPhone 15 (Mobile)',
      },
      {
        user_id: '0192df40-7e12-7000-8000-000000000003',
        device_id: '0192df40-7e12-7000-8000-00000000000c',
        display_name: 'Firefox trên Linux (Laptop)',
      },
    ];

    const fixtures: Array<{
      device_id: string;
      user_id: string;
      display_name: string;
      curve25519_key: string;
      ed25519_key: string;
      device_keys_canonical_json: string;
      signature: string;
      registration_body: {
        display_name: string;
        curve25519_key: string;
        ed25519_key: string;
        signature: string;
        fallback_key: {
          key_id: string;
          public_key: string;
          signature: string;
        };
      };
      one_time_keys: Array<{
        key_id: string;
        public_key: string;
        canonical_json: string;
        signature: string;
      }>;
      fallback_key: {
        key_id: string;
        public_key: string;
        canonical_json: string;
        signature: string;
      };
    }> = [];

    for (const dev of devicesData) {
      const account = new Account();
      const curve25519_key = account.curve25519Key();
      const ed25519_key = account.ed25519Key();

      // Canonical device registration payload
      const deviceCanonical = buildDeviceKeysPayload({
        userId: dev.user_id,
        deviceId: dev.device_id,
        curve25519: curve25519_key,
        ed25519: ed25519_key,
      });
      const deviceSignature = account.sign(deviceCanonical);
      expect(verifyWithNodeCrypto(ed25519_key, deviceCanonical, deviceSignature)).toBe(true);

      // Fallback key
      account.generateFallbackKey();
      const fallbackObj = JSON.parse(account.fallbackKey());
      const fallbackCanonical = buildOneTimeKeyPayload({
        deviceId: dev.device_id,
        keyId: fallbackObj.key_id,
        key: fallbackObj.key,
        fallback: true,
      });
      const fallbackSig = account.sign(fallbackCanonical);
      expect(verifyWithNodeCrypto(ed25519_key, fallbackCanonical, fallbackSig)).toBe(true);

      // One-time keys (3 sample OTKs)
      account.generateOneTimeKeys(5);
      const otks = JSON.parse(account.oneTimeKeys()).curve25519;
      const otkEntries = Object.entries(otks).slice(0, 3) as Array<[string, string]>;
      const oneTimeKeysList = otkEntries.map(([keyId, keyPub]) => {
        const canonical = buildOneTimeKeyPayload({
          deviceId: dev.device_id,
          keyId,
          key: keyPub,
          fallback: false,
        });
        const sig = account.sign(canonical);
        expect(verifyWithNodeCrypto(ed25519_key, canonical, sig)).toBe(true);
        return {
          key_id: keyId,
          public_key: keyPub,
          canonical_json: canonical,
          signature: sig,
        };
      });

      fixtures.push({
        device_id: dev.device_id,
        user_id: dev.user_id,
        display_name: dev.display_name,
        curve25519_key,
        ed25519_key,
        device_keys_canonical_json: deviceCanonical,
        signature: deviceSignature,
        registration_body: {
          display_name: dev.display_name,
          curve25519_key,
          ed25519_key,
          signature: deviceSignature,
          fallback_key: {
            key_id: fallbackObj.key_id,
            public_key: fallbackObj.key,
            signature: fallbackSig,
          },
        },
        one_time_keys: oneTimeKeysList,
        fallback_key: {
          key_id: fallbackObj.key_id,
          public_key: fallbackObj.key,
          canonical_json: fallbackCanonical,
          signature: fallbackSig,
        },
      });
    }

    // Save fixtures to disk if file does not exist or UPDATE_FIXTURES is set
    const fixturesDir = path.resolve(__dirname, '../fixtures');
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
    const fixtureFilePath = path.join(fixturesDir, 'chat-e2ee-signed-keys.json');
    if (!fs.existsSync(fixtureFilePath) || process.env.UPDATE_FIXTURES) {
      fs.writeFileSync(fixtureFilePath, JSON.stringify(fixtures, null, 2) + '\n', 'utf8');
    }

    expect(fixtures.length).toBe(3);
    expect(fs.existsSync(fixtureFilePath)).toBe(true);
  });
});
