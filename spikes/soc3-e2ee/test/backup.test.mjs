import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { argon2id } from 'hash-wasm';

const subtle = crypto.webcrypto.subtle;

describe('Key Backup: Argon2id Key Derivation & AES-256-GCM Envelope', () => {
  test('Argon2id (64 MiB, 3 iterations, 1 parallelism) + AES-256-GCM backup roundtrip', async () => {
    const passphrase = 'user-secure-recovery-passphrase-phrase-1234';
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // 1. Key Derivation via Argon2id (WASM)
    const t0 = performance.now();
    const derivedKeyHex = await argon2id({
      password: passphrase,
      salt: salt,
      iterations: 3,
      memorySize: 64 * 1024, // 64 MiB
      parallelism: 1,
      hashLength: 32,
      outputType: 'hex',
    });
    const derivationTime = performance.now() - t0;
    assert.ok(derivationTime > 50, 'Argon2id derivation should perform meaningful work');

    // Convert hex to 32-byte key buffer
    const derivedKeyBytes = new Uint8Array(
      derivedKeyHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)),
    );

    const backupKey = await subtle.importKey('raw', derivedKeyBytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);

    // 2. Encrypt sample key backup blob (Olm identity + Megolm sessions JSON)
    const backupPayload = JSON.stringify({
      version: 1,
      account_id: '0192e2ee-account-id',
      identity_curve25519: 'n0W5hG9...',
      inbound_group_sessions: [
        { room_id: '!room:winkey.vn', session_id: 'sess_123', key: 'megolm_key_data' },
      ],
    });

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedBlob = await subtle.encrypt(
      { name: 'AES-GCM', iv },
      backupKey,
      new TextEncoder().encode(backupPayload),
    );

    // 3. Decrypt with correct passphrase
    const decryptedBytes = await subtle.decrypt({ name: 'AES-GCM', iv }, backupKey, encryptedBlob);
    const restoredText = new TextDecoder().decode(decryptedBytes);
    assert.equal(restoredText, backupPayload, 'Restored backup must match original');

    // 4. Decrypt with wrong passphrase must fail
    const wrongKeyHex = await argon2id({
      password: 'wrong-passphrase',
      salt: salt,
      iterations: 3,
      memorySize: 64 * 1024,
      parallelism: 1,
      hashLength: 32,
      outputType: 'hex',
    });
    const wrongKeyBytes = new Uint8Array(
      wrongKeyHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)),
    );
    const wrongBackupKey = await subtle.importKey(
      'raw',
      wrongKeyBytes,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    await assert.rejects(
      async () => {
        await subtle.decrypt({ name: 'AES-GCM', iv }, wrongBackupKey, encryptedBlob);
      },
      /operation failed|tag/i,
      'Decryption with wrong password must be rejected by AES-GCM tag check',
    );
  });
});
