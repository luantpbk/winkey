import { describe, it, expect } from 'vitest';
import { Keyring, getKeyring } from '../../src/crypto/keyring.js';

describe('Keyring AES-256-GCM encryption & key rotation', () => {
  const key1 = Buffer.alloc(32, 1).toString('base64');
  const key2 = Buffer.alloc(32, 2).toString('base64');
  const salt = 'a-very-long-test-salt-for-ip-hashing-min-32-bytes!';

  it('encrypts with the primary key and decrypts successfully', () => {
    const keyring = new Keyring(`k1:${key1}`, salt);
    const plaintext = 'JBSWY3DPEHPK3PXP';
    const encrypted = keyring.encrypt(plaintext);

    expect(encrypted.keyId).toBe('k1');
    const decrypted = keyring.decrypt(encrypted.keyId, encrypted.payload);
    expect(decrypted.toString('utf8')).toBe(plaintext);
  });

  it('supports key rotation: decrypts ciphertext produced by an older key', () => {
    const oldKeyring = new Keyring(`k1:${key1}`, salt);
    const plaintext = 'SECRET_TOTP_KEY_OLD';
    const oldEncrypted = oldKeyring.encrypt(plaintext);

    // New keyring has k2 as primary, k1 as secondary
    const newKeyring = new Keyring(`k2:${key2},k1:${key1}`, salt);

    // Decrypts old ciphertext using k1
    const decryptedOld = newKeyring.decrypt(oldEncrypted.keyId, oldEncrypted.payload);
    expect(decryptedOld.toString('utf8')).toBe(plaintext);

    // Encrypts new ciphertext using primary key k2
    const newEncrypted = newKeyring.encrypt(plaintext);
    expect(newEncrypted.keyId).toBe('k2');
    const decryptedNew = newKeyring.decrypt(newEncrypted.keyId, newEncrypted.payload);
    expect(decryptedNew.toString('utf8')).toBe(plaintext);
  });

  it('fails decryption if key id is unknown in keyring', () => {
    const keyring = new Keyring(`k2:${key2}`, salt);
    const fakePayload = Buffer.alloc(30, 0);
    expect(() => keyring.decrypt('k99', fakePayload)).toThrow(/UNKNOWN_KEY_ID/);
  });

  it('fails decryption if ciphertext or auth tag is corrupted', () => {
    const keyring = new Keyring(`k1:${key1}`, salt);
    const encrypted = keyring.encrypt('sensitive data');
    // Tamper with payload
    const tamperedPayload = Buffer.from(encrypted.payload);
    tamperedPayload[tamperedPayload.length - 1] ^= 0xff;

    expect(() => keyring.decrypt(encrypted.keyId, tamperedPayload)).toThrow();
  });
});

describe('hashIp HMAC-SHA256', () => {
  const key1 = Buffer.alloc(32, 1).toString('base64');
  const salt = 'a-very-long-test-salt-for-ip-hashing-min-32-bytes!';

  it('produces deterministic 32-byte binary Buffer', () => {
    const keyring = new Keyring(`k1:${key1}`, salt);
    const ip = '203.0.113.195';
    const hash1 = keyring.hashIp(ip);
    const hash2 = keyring.hashIp(ip);

    expect(hash1).not.toBeNull();
    expect(hash2).not.toBeNull();
    expect(hash1!.equals(hash2!)).toBe(true);
    expect(hash1!.length).toBe(32);
  });

  it('produces different hashes for different IPs or salts', () => {
    const keyring1 = new Keyring(`k1:${key1}`, salt);
    const keyring2 = new Keyring(`k1:${key1}`, 'another-salt-that-is-at-least-32-bytes-long-now!');

    const hashA = keyring1.hashIp('203.0.113.1');
    const hashB = keyring1.hashIp('203.0.113.2');
    const hashC = keyring2.hashIp('203.0.113.1');

    expect(hashA!.equals(hashB!)).toBe(false);
    expect(hashA!.equals(hashC!)).toBe(false);
  });

  it('returns null for undefined or null IP', () => {
    const keyring = new Keyring(`k1:${key1}`, salt);
    expect(keyring.hashIp(null)).toBeNull();
    expect(keyring.hashIp(undefined)).toBeNull();
  });
});

describe('getKeyring environment validation', () => {
  it('allows fallback keys only when NODE_ENV is test', () => {
    const keyringTest = getKeyring({ NODE_ENV: 'test' });
    expect(keyringTest).toBeInstanceOf(Keyring);
    expect(keyringTest.primaryKeyId).toBe('k1');
  });

  it('throws an error when fallback keys are used in non-test environment', () => {
    expect(() => getKeyring({ NODE_ENV: 'production' })).toThrow(
      /Fallback keys are only permitted when NODE_ENV=test/,
    );
    expect(() => getKeyring({ NODE_ENV: 'development' })).toThrow(
      /Fallback keys are only permitted when NODE_ENV=test/,
    );
  });

  it('accepts explicit keys and salt in production environment', () => {
    const key1 = Buffer.alloc(32, 5).toString('base64');
    const salt = 'valid-production-salt-that-is-at-least-32-bytes-long!';
    const keyringProd = getKeyring({
      NODE_ENV: 'production',
      TOTP_ENCRYPTION_KEYS: `k1:${key1}`,
      SESSION_IP_SALT: salt,
    });
    expect(keyringProd).toBeInstanceOf(Keyring);
  });
});
