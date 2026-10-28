import { describe, it, expect } from 'vitest';
import {
  generateRecoveryCodeBatch,
  normalizeRecoveryCode,
  verifyRecoveryCode,
  ARGON2_RECOVERY_CONFIG,
} from '../../src/crypto/recovery.js';
import { hash } from '@node-rs/argon2';

describe('Recovery Codes CSPRNG & Argon2id hashing', () => {
  it('generates recovery codes matching [a-z2-9]{5}-[a-z2-9]{5}', async () => {
    const { formattedCodes, hashes } = await generateRecoveryCodeBatch(10);
    expect(formattedCodes).toHaveLength(10);
    expect(hashes).toHaveLength(10);

    const regex = /^[a-z2-9]{5}-[a-z2-9]{5}$/;
    for (const code of formattedCodes) {
      expect(code).toMatch(regex);
      // Excludes digits 0 and 1 (uses 2-9)
      expect(code).not.toMatch(/[01]/);
    }
  });

  it('normalizes recovery codes ignoring case, dashes, and whitespace', () => {
    expect(normalizeRecoveryCode('abc23-def45')).toBe('abc23def45');
    expect(normalizeRecoveryCode('ABC23-DEF45')).toBe('abc23def45');
    expect(normalizeRecoveryCode('  abc23  def45  ')).toBe('abc23def45');
    expect(normalizeRecoveryCode('abc23def45')).toBe('abc23def45');
  });

  it('hashes normalized code with Argon2id and verifies successfully', async () => {
    const rawCode = 'abc23-def45';
    const normalized = normalizeRecoveryCode(rawCode);
    const codeHash = await hash(normalized, ARGON2_RECOVERY_CONFIG);

    expect(codeHash.startsWith('$argon2id$')).toBe(true);

    // Verify exact code
    expect(await verifyRecoveryCode(codeHash, rawCode)).toBe(true);

    // Verify with uppercase and spaces
    expect(await verifyRecoveryCode(codeHash, 'ABC23 DEF45')).toBe(true);

    // Verify with raw normalized string
    expect(await verifyRecoveryCode(codeHash, 'abc23def45')).toBe(true);

    // Verify wrong code fails
    expect(await verifyRecoveryCode(codeHash, 'abc23-def99')).toBe(false);
  });
});
