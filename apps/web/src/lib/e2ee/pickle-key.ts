/**
 * Pickle Key Protection using Non-extractable WebCrypto AES-256-GCM (ADR-049 / SOC-3a)
 *
 * - A non-extractable CryptoKey wraps a random 32-byte pickle key.
 * - AES-GCM provides authenticated encryption with a 96-bit (12-byte) random IV.
 * - If tampering or a wrong key is used, WebCrypto GCM tag verification rejects with an error.
 */

export interface WrappedPickleKey {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export async function generateMasterStorageKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    false, // extractable = false (Main thread / XSS cannot export raw key bytes)
    ['encrypt', 'decrypt'],
  );
}

export function generateRandomPickleKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

export async function wrapPickleKey(
  storageKey: CryptoKey,
  rawPickleKey: Uint8Array,
): Promise<WrappedPickleKey> {
  if (rawPickleKey.length !== 32) {
    throw new Error('Pickle key must be exactly 32 bytes');
  }

  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as any,
    },
    storageKey,
    rawPickleKey as any,
  );

  return {
    iv,
    ciphertext: new Uint8Array(ciphertextBuffer),
  };
}

export async function unwrapPickleKey(
  storageKey: CryptoKey,
  wrapped: WrappedPickleKey,
): Promise<Uint8Array> {
  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: wrapped.iv as any,
    },
    storageKey,
    wrapped.ciphertext as any,
  );

  const result = new Uint8Array(decryptedBuffer);
  if (result.length !== 32) {
    throw new Error('Decrypted pickle key invalid length');
  }
  return result;
}
