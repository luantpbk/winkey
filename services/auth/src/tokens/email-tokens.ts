import crypto from 'node:crypto';
import type { EmailTokenPurpose } from '../db/types.js';

export const RESET_PASSWORD_TTL_MS = 60 * 60 * 1000; // 1 hour
export const VERIFY_EMAIL_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

export interface GeneratedEmailToken {
  rawToken: string;
  tokenHash: Buffer;
  expiresAt: Date;
}

/**
 * Generates an opaque one-time email token.
 * Uses 32 cryptographically secure random bytes formatted as unpadded base64url (43 chars).
 * Computes the SHA-256 hash (32 bytes Buffer) to store in the database.
 */
export function generateEmailToken(
  purpose: EmailTokenPurpose,
  now: Date = new Date(),
): GeneratedEmailToken {
  const rawBytes = crypto.randomBytes(32);
  const rawToken = rawBytes.toString('base64url'); // exactly 43 chars, no padding
  const tokenHash = hashEmailToken(rawToken);
  const ttlMs = purpose === 'RESET_PASSWORD' ? RESET_PASSWORD_TTL_MS : VERIFY_EMAIL_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);

  return {
    rawToken,
    tokenHash,
    expiresAt,
  };
}

/**
 * Hashes an opaque raw token using SHA-256 to lookup or compare with the database.
 */
export function hashEmailToken(rawToken: string): Buffer {
  return crypto.createHash('sha256').update(rawToken).digest();
}

/**
 * Validates the raw token string format (43 chars base64url).
 */
export function isValidTokenFormat(rawToken: unknown): rawToken is string {
  return typeof rawToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(rawToken);
}
