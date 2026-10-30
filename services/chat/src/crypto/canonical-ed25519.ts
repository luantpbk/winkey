import crypto from 'node:crypto';

const UNPADDED_B64_REGEX = /^[A-Za-z0-9+/]+$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function decodeUnpaddedBase64(b64: string, expectedBytes: number): Buffer | null {
  if (!b64 || typeof b64 !== 'string' || !UNPADDED_B64_REGEX.test(b64)) {
    return null;
  }
  // Compute expected unpadded length
  const expectedChars = Math.ceil((expectedBytes * 8) / 6);
  if (b64.length !== expectedChars) {
    return null;
  }

  // Calculate needed padding for Buffer.from
  const remainder = b64.length % 4;
  const padding = remainder === 0 ? '' : '='.repeat(4 - remainder);
  const buf = Buffer.from(b64 + padding, 'base64');
  if (buf.byteLength !== expectedBytes) {
    return null;
  }

  // Canonical representation check: re-encoding without padding must equal original
  if (buf.toString('base64').replace(/=+$/, '') !== b64) {
    return null;
  }
  return buf;
}

export function encodeUnpaddedBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

/**
 * RFC 8785 Canonical JSON representation.
 * Keys are lexicographically sorted by Unicode code point at every nesting level.
 * No extraneous whitespace is included.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of sortedKeys) {
    if (obj[k] !== undefined) {
      parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    }
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Verifies an Ed25519 signature over a canonical JSON object payload using the raw 32-byte Ed25519 public key.
 */
export function verifyEd25519Canonical(
  ed25519KeyB64: string,
  payloadObj: Record<string, unknown>,
  signatureB64: string,
): boolean {
  try {
    const rawPub = decodeUnpaddedBase64(ed25519KeyB64, 32);
    const sigBuf = decodeUnpaddedBase64(signatureB64, 64);
    if (!rawPub || !sigBuf) return false;

    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPub]),
      format: 'der',
      type: 'spki',
    });

    const data = Buffer.from(canonicalJson(payloadObj), 'utf8');
    return crypto.verify(null, data, keyObj, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Verifies device registration signature.
 * Canonical payload:
 * {"algorithms":["m.megolm.v1.aes-sha2","m.olm.v1.curve25519-aes-sha2"],"curve25519":K,"device_id":D,"ed25519":E,"user_id":U}
 */
export function verifyDeviceRegistrationSignature(
  deviceId: string,
  userId: string,
  curve25519Key: string,
  ed25519Key: string,
  signature: string,
): boolean {
  const payload = {
    algorithms: ['m.megolm.v1.aes-sha2', 'm.olm.v1.curve25519-aes-sha2'],
    curve25519: curve25519Key,
    device_id: deviceId,
    ed25519: ed25519Key,
    user_id: userId,
  };
  return verifyEd25519Canonical(ed25519Key, payload, signature);
}

/**
 * Verifies one-time key or fallback key signature.
 * Canonical payload:
 * {"device_id":D,"fallback":fallback,"key":K,"key_id":I}
 */
export function verifySignedKeySignature(
  deviceId: string,
  keyId: string,
  publicKey: string,
  signature: string,
  ed25519Key: string,
  fallback: boolean,
): boolean {
  const payload = {
    device_id: deviceId,
    fallback,
    key: publicKey,
    key_id: keyId,
  };
  return verifyEd25519Canonical(ed25519Key, payload, signature);
}
