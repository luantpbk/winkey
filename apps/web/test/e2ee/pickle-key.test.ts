import { describe, it, expect } from 'vitest';
import {
  generateMasterStorageKey,
  generateRandomPickleKey,
  wrapPickleKey,
  unwrapPickleKey,
} from '../../src/lib/e2ee/pickle-key';

describe('Pickle Key Protection via Non-Extractable WebCrypto AES-GCM (ADR-049 / SOC-3a)', () => {
  it('generates a non-extractable master storage key', async () => {
    const key = await generateMasterStorageKey();
    expect(key.type).toBe('secret');
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
  });

  it('generates a 32-byte random pickle key', () => {
    const rawKey = generateRandomPickleKey();
    expect(rawKey.byteLength).toBe(32);
  });

  it('wraps and unwraps pickle key roundtrip', async () => {
    const masterKey = await generateMasterStorageKey();
    const rawKey = generateRandomPickleKey();

    const wrapped = await wrapPickleKey(masterKey, rawKey);
    expect(wrapped.iv.byteLength).toBe(12);
    expect(wrapped.ciphertext.byteLength).toBeGreaterThan(32); // 32 bytes + 16 byte GCM tag = 48 bytes

    const unwrapped = await unwrapPickleKey(masterKey, wrapped);
    expect(Array.from(unwrapped)).toEqual(Array.from(rawKey));
  });

  it('fails with wrong key (verifies unwrap failure requirement)', async () => {
    const masterKeyA = await generateMasterStorageKey();
    const masterKeyB = await generateMasterStorageKey();
    const rawKey = generateRandomPickleKey();

    const wrapped = await wrapPickleKey(masterKeyA, rawKey);

    // Attempting to unwrap with wrong master key must reject
    await expect(unwrapPickleKey(masterKeyB, wrapped)).rejects.toThrow();
  });

  it('fails when ciphertext or IV is tampered', async () => {
    const masterKey = await generateMasterStorageKey();
    const rawKey = generateRandomPickleKey();

    const wrapped = await wrapPickleKey(masterKey, rawKey);

    // Tamper ciphertext
    const tamperedCiphertext = new Uint8Array(wrapped.ciphertext);
    tamperedCiphertext[0] ^= 0xff;

    await expect(
      unwrapPickleKey(masterKey, { iv: wrapped.iv, ciphertext: tamperedCiphertext }),
    ).rejects.toThrow();

    // Tamper IV
    const tamperedIv = new Uint8Array(wrapped.iv);
    tamperedIv[0] ^= 0xff;

    await expect(
      unwrapPickleKey(masterKey, { iv: tamperedIv, ciphertext: wrapped.ciphertext }),
    ).rejects.toThrow();
  });
});
