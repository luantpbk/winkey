import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export class Keyring {
  private readonly keys = new Map<string, Buffer>();
  public readonly primaryKeyId: string;
  private readonly ipSalt: string;

  constructor(envKeys: string, ipSalt: string) {
    this.ipSalt = ipSalt;
    const pairs = envKeys
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (pairs.length === 0) {
      throw new Error('EMPTY_TOTP_KEYRING: TOTP_ENCRYPTION_KEYS must contain at least one key');
    }

    for (const pair of pairs) {
      const [id, b64] = pair.split(':');
      const buf = Buffer.from(b64 ?? '', 'base64');
      if (!id || buf.byteLength !== 32) {
        throw new Error(`INVALID_KEY_SPEC: Key '${id}' must be 32 bytes base64`);
      }
      this.keys.set(id, buf);
    }
    this.primaryKeyId = pairs[0].split(':')[0];
  }

  encrypt(plaintext: Buffer | string): { keyId: string; payload: Buffer } {
    const key = this.keys.get(this.primaryKeyId);
    if (!key) {
      throw new Error(`PRIMARY_KEY_NOT_FOUND: ${this.primaryKeyId}`);
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag(); // 16 bytes
    return {
      keyId: this.primaryKeyId,
      payload: Buffer.concat([nonce, ciphertext, tag]),
    };
  }

  decrypt(keyId: string, payload: Buffer): Buffer {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`UNKNOWN_KEY_ID: ${keyId}`);
    }
    if (payload.byteLength < 28) {
      // 12 bytes nonce + 0 bytes min ciphertext + 16 bytes auth tag = 28 bytes
      throw new Error('MALFORMED_CIPHERTEXT: Payload is too short');
    }

    const nonce = payload.subarray(0, 12);
    const tag = payload.subarray(payload.byteLength - 16);
    const ciphertext = payload.subarray(12, payload.byteLength - 16);

    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  hashIp(ip: string | undefined | null): Buffer | null {
    if (!ip) return null;
    return createHmac('sha256', this.ipSalt).update(ip.trim()).digest();
  }
}

let cachedKeyring: Keyring | null = null;
let lastKeyringEnv = '';

export function getKeyring(env: {
  TOTP_ENCRYPTION_KEYS?: string;
  SESSION_IP_SALT?: string;
  NODE_ENV?: string;
}): Keyring {
  const envKey = `${env.TOTP_ENCRYPTION_KEYS ?? ''}::${env.SESSION_IP_SALT ?? ''}::${env.NODE_ENV ?? ''}`;
  if (cachedKeyring && lastKeyringEnv === envKey) {
    return cachedKeyring;
  }
  const isTest = env.NODE_ENV ? env.NODE_ENV === 'test' : process.env.NODE_ENV === 'test';
  if (!isTest && (!env.TOTP_ENCRYPTION_KEYS || !env.SESSION_IP_SALT)) {
    throw new Error('KEYRING_ERROR: Fallback keys are only permitted when NODE_ENV=test');
  }
  const keys = env.TOTP_ENCRYPTION_KEYS || `k1:${Buffer.alloc(32, 1).toString('base64')}`;
  const salt = env.SESSION_IP_SALT || 'default_test_salt_at_least_32_bytes_long_123';
  cachedKeyring = new Keyring(keys, salt);
  lastKeyringEnv = envKey;
  return cachedKeyring;
}
