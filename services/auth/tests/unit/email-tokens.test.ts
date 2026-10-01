import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  generateEmailToken,
  hashEmailToken,
  isValidTokenFormat,
  RESET_PASSWORD_TTL_MS,
  VERIFY_EMAIL_TTL_MS,
} from '../../src/tokens/email-tokens.js';

describe('email-tokens', () => {
  it('generates a 43-character base64url token with 32-byte SHA-256 hash', () => {
    const { rawToken, tokenHash, expiresAt } = generateEmailToken('RESET_PASSWORD');

    // 32 random bytes in base64url without padding is exactly 43 chars
    expect(rawToken).toHaveLength(43);
    expect(isValidTokenFormat(rawToken)).toBe(true);

    // tokenHash is SHA-256 (32 bytes)
    expect(Buffer.isBuffer(tokenHash)).toBe(true);
    expect(tokenHash).toHaveLength(32);

    // Direct hash check
    const expectedHash = crypto.createHash('sha256').update(rawToken).digest();
    expect(tokenHash.equals(expectedHash)).toBe(true);

    // TTL for reset is 1 hour
    const expectedExpiry = Date.now() + RESET_PASSWORD_TTL_MS;
    expect(Math.abs(expiresAt.getTime() - expectedExpiry)).toBeLessThan(2000);
  });

  it('sets 48-hour TTL for VERIFY_EMAIL tokens', () => {
    const { rawToken, tokenHash, expiresAt } = generateEmailToken('VERIFY_EMAIL');

    expect(isValidTokenFormat(rawToken)).toBe(true);
    expect(tokenHash).toHaveLength(32);

    const expectedExpiry = Date.now() + VERIFY_EMAIL_TTL_MS;
    expect(Math.abs(expiresAt.getTime() - expectedExpiry)).toBeLessThan(2000);
  });

  it('hashEmailToken produces consistent SHA-256 buffer', () => {
    const raw = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
    const hash1 = hashEmailToken(raw);
    const hash2 = hashEmailToken(raw);

    expect(hash1.equals(hash2)).toBe(true);
    expect(hash1).toHaveLength(32);
  });

  it('isValidTokenFormat checks 43-character base64url characters', () => {
    expect(isValidTokenFormat('abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE')).toBe(true);
    // Too short
    expect(isValidTokenFormat('abc')).toBe(false);
    // Too long
    expect(isValidTokenFormat('abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEextra')).toBe(false);
    // Invalid characters (padding '=' or '+', '/')
    expect(isValidTokenFormat('abcdefghijklmnopqrstuvwxyz0123456789-_ABCD=')).toBe(false);
    expect(isValidTokenFormat('abcdefghijklmnopqrstuvwxyz0123456789+/ABCDE')).toBe(false);
    // Non-string
    expect(isValidTokenFormat(null)).toBe(false);
    expect(isValidTokenFormat(12345)).toBe(false);
  });
});
