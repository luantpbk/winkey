import { generateSecret, verifySync, generateSync } from 'otplib';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  // 160-bit (20 bytes) base32 encoded -> 32 characters, no padding
  return generateSecret({ length: 20 });
}

export function matchTotpStep(
  secretBase32: string,
  token: string,
  nowEpochSec = Math.floor(Date.now() / 1000),
): bigint | null {
  const trimmed = token.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    return null;
  }

  const result = verifySync({
    secret: secretBase32,
    token: trimmed,
    epoch: nowEpochSec,
    epochTolerance: TOTP_STEP_SECONDS, // allows +-1 window (30s)
  }) as { valid: boolean; timeStep?: number };

  if (result.valid && typeof result.timeStep === 'number') {
    return BigInt(result.timeStep);
  }
  return null;
}

export function generateTotpCode(
  secretBase32: string,
  nowEpochSec = Math.floor(Date.now() / 1000),
): string {
  return generateSync({
    secret: secretBase32,
    epoch: nowEpochSec,
  });
}

export function buildOtpauthUri(handle: string, secretBase32: string, issuer = 'Winkey'): string {
  const encIssuer = encodeURIComponent(issuer);
  const encHandle = encodeURIComponent(handle);
  return `otpauth://totp/${encIssuer}:${encHandle}?secret=${secretBase32}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}
