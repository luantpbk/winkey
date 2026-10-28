import type { MfaChallenge } from '@winkey/api-client';

let inMemoryMfaChallenge: MfaChallenge | null = null;

export function setPendingMfaChallenge(challenge: MfaChallenge | null): void {
  inMemoryMfaChallenge = challenge;
}

export function getPendingMfaChallenge(): MfaChallenge | null {
  return inMemoryMfaChallenge;
}

export function clearPendingMfaChallenge(): void {
  inMemoryMfaChallenge = null;
}
