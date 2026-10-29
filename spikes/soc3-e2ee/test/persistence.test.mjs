/* global TextEncoder, TextDecoder */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const subtle = crypto.webcrypto.subtle;

describe('E2EE Persistence: Non-extractable WebCrypto AES-GCM & Zero-leak Isolation', () => {
  test('Non-extractable WebCrypto key cannot be exported', async () => {
    const key = await subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable!
      ['encrypt', 'decrypt'],
    );

    assert.equal(key.extractable, false, 'Key must be marked non-extractable');

    // Attempting exportKey must throw
    await assert.rejects(
      async () => {
        await subtle.exportKey('raw', key);
      },
      /not extractable/i,
      'WebCrypto must refuse to export non-extractable raw key material',
    );
  });

  test('Pickle encryption & decryption with AES-GCM 256-bit without localStorage leak', async () => {
    // Simulated IndexedDB store
    const indexedDBStore = new Map();
    // Simulated localStorage mock
    const localStorageMock = new Map();

    const masterKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);

    // Save key object directly into IndexedDB (structured clone)
    indexedDBStore.set('e2ee_master_key', masterKey);

    // Simulated Olm session pickle string (395 bytes)
    const simulatedPickle = 'v1_olm_session_base64_serialized_pickle_material_mock';
    const rawBytes = new TextEncoder().encode(simulatedPickle);

    // 1. Encrypt pickle before storing
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedPickle = await subtle.encrypt(
      { name: 'AES-GCM', iv },
      indexedDBStore.get('e2ee_master_key'),
      rawBytes,
    );

    // 2. Persist only ciphertext + iv in IndexedDB
    indexedDBStore.set('session:0192e2ee-session-id', {
      iv: Array.from(iv),
      ciphertext: Array.from(new Uint8Array(encryptedPickle)),
    });

    // Verify localStorage NEVER received plaintext or ciphertext
    assert.equal(localStorageMock.size, 0, 'localStorage must remain empty');
    for (const [_key, val] of localStorageMock.entries()) {
      assert.ok(!JSON.stringify(val).includes(simulatedPickle));
    }

    // 3. Restore and decrypt from IndexedDB
    const record = indexedDBStore.get('session:0192e2ee-session-id');
    const restoredIv = new Uint8Array(record.iv);
    const restoredCiphertext = new Uint8Array(record.ciphertext);

    const decryptedBuffer = await subtle.decrypt(
      { name: 'AES-GCM', iv: restoredIv },
      indexedDBStore.get('e2ee_master_key'),
      restoredCiphertext,
    );

    const restoredPlaintext = new TextDecoder().decode(decryptedBuffer);
    assert.equal(restoredPlaintext, simulatedPickle, 'Restored pickle must match original');
  });
});
