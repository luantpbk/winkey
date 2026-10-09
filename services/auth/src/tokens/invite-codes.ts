import crypto from 'node:crypto';
import type { Env } from '../config/env.js';

export type CheckInviteResult =
  { ok: true; index: number | null } | { ok: false; reason: 'INVITE_REQUIRED' | 'INVITE_INVALID' };

/**
 * Validates an invite code in constant time (ADR-034, Task BETA1).
 *
 * In open mode, always succeeds with index null.
 * In invite mode:
 * - Missing/empty code -> returns INVITE_REQUIRED.
 * - Computes SHA-256 digest of input and compares against EVERY configured digest
 *   with crypto.timingSafeEqual without early exit, ensuring constant-time comparison.
 * - Returns matched index (0-based) on success, or INVITE_INVALID on mismatch.
 */
export function checkInvite(env: Env, code?: string): CheckInviteResult {
  if (env.REGISTRATION_MODE === 'open') {
    return { ok: true, index: null };
  }

  if (!code || typeof code !== 'string' || code.trim() === '') {
    return { ok: false, reason: 'INVITE_REQUIRED' };
  }

  const inputHash = crypto.createHash('sha256').update(code).digest();

  let matchedIndex: number | null = null;
  const digests = env.inviteCodeDigests;

  for (let i = 0; i < digests.length; i++) {
    const isMatch = crypto.timingSafeEqual(inputHash, digests[i]);
    if (isMatch && matchedIndex === null) {
      matchedIndex = i;
    }
  }

  if (matchedIndex !== null) {
    return { ok: true, index: matchedIndex };
  }

  return { ok: false, reason: 'INVITE_INVALID' };
}
