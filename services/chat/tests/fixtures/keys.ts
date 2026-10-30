import crypto from 'node:crypto';
import { canonicalJson, encodeUnpaddedBase64 } from '../../src/crypto/canonical-ed25519.js';

export interface TestDeviceKeys {
  deviceId: string;
  userId: string;
  displayName: string;
  curve25519Key: string;
  ed25519Key: string;
  signature: string;
  edPrivateKey: crypto.KeyObject;
  fallbackKey?: {
    key_id: string;
    public_key: string;
    signature: string;
  };
}

export function generateTestDeviceKeys(
  deviceId: string,
  userId: string,
  displayName = 'Test Device',
  withFallback = true,
  customCurve25519Key?: string,
): TestDeviceKeys {
  const edPair = crypto.generateKeyPairSync('ed25519');
  const xPair = crypto.generateKeyPairSync('x25519');

  const edPubRaw = edPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const xPubRaw = xPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);

  const ed25519Key = encodeUnpaddedBase64(edPubRaw);
  const curve25519Key = customCurve25519Key ?? encodeUnpaddedBase64(xPubRaw);

  const devicePayload = {
    algorithms: ['m.megolm.v1.aes-sha2', 'm.olm.v1.curve25519-aes-sha2'],
    curve25519: curve25519Key,
    device_id: deviceId,
    ed25519: ed25519Key,
    user_id: userId,
  };

  const deviceData = Buffer.from(canonicalJson(devicePayload), 'utf8');
  const signatureRaw = crypto.sign(null, deviceData, edPair.privateKey);
  const signature = encodeUnpaddedBase64(signatureRaw);

  let fallbackKey: TestDeviceKeys['fallbackKey'] | undefined;
  if (withFallback) {
    const fbPair = crypto.generateKeyPairSync('x25519');
    const fbPubRaw = fbPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    const fbPub = encodeUnpaddedBase64(fbPubRaw);
    const fbKeyId = 'fallback_01';

    const fbPayload = {
      device_id: deviceId,
      fallback: true,
      key: fbPub,
      key_id: fbKeyId,
    };
    const fbData = Buffer.from(canonicalJson(fbPayload), 'utf8');
    const fbSigRaw = crypto.sign(null, fbData, edPair.privateKey);
    const fbSig = encodeUnpaddedBase64(fbSigRaw);

    fallbackKey = {
      key_id: fbKeyId,
      public_key: fbPub,
      signature: fbSig,
    };
  }

  return {
    deviceId,
    userId,
    displayName,
    curve25519Key,
    ed25519Key,
    signature,
    edPrivateKey: edPair.privateKey,
    fallbackKey,
  };
}

export function generateTestOneTimeKeys(
  device: TestDeviceKeys,
  count: number,
  startIdx = 1,
): Array<{ key_id: string; public_key: string; signature: string }> {
  const result: Array<{ key_id: string; public_key: string; signature: string }> = [];

  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    const otkPair = crypto.generateKeyPairSync('x25519');
    const otkPubRaw = otkPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    const pub = encodeUnpaddedBase64(otkPubRaw);
    const keyId = `otk_${String(idx).padStart(4, '0')}`;

    const payload = {
      device_id: device.deviceId,
      fallback: false,
      key: pub,
      key_id: keyId,
    };
    const data = Buffer.from(canonicalJson(payload), 'utf8');
    const sigRaw = crypto.sign(null, data, device.edPrivateKey);
    const sig = encodeUnpaddedBase64(sigRaw);

    result.push({
      key_id: keyId,
      public_key: pub,
      signature: sig,
    });
  }

  return result;
}
