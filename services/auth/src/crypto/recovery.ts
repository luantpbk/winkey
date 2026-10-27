import { randomInt } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';

const CHARSET = 'abcdefghijklmnopqrstuvwxyz23456789'; // 34 characters: [a-z2-9]

export const ARGON2_RECOVERY_CONFIG = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: Algorithm.Argon2id,
};

/**
 * Normalizes recovery code by converting to lowercase and stripping spaces and hyphens.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '').trim();
}

/**
 * Generates a single formatted recovery code in `xxxxx-xxxxx` format.
 */
export function generateRecoveryCode(): { raw: string; formatted: string } {
  let raw = '';
  for (let i = 0; i < 10; i++) {
    raw += CHARSET[randomInt(0, CHARSET.length)];
  }
  const formatted = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  return { raw, formatted };
}

/**
 * Generates 10 new recovery codes and their argon2id hashes.
 */
export async function generateRecoveryCodeBatch(count = 10): Promise<{
  formattedCodes: string[];
  hashes: string[];
}> {
  const formattedCodes: string[] = [];
  const hashes: string[] = [];

  for (let i = 0; i < count; i++) {
    const { raw, formatted } = generateRecoveryCode();
    formattedCodes.push(formatted);
    const codeHash = await hash(raw, ARGON2_RECOVERY_CONFIG);
    hashes.push(codeHash);
  }

  return { formattedCodes, hashes };
}

/**
 * Verifies a candidate code against a stored argon2id hash.
 */
export async function verifyRecoveryCode(storedHash: string, candidate: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(candidate);
  if (!/^[a-z2-9]{10}$/.test(normalized)) {
    return false;
  }
  try {
    return await verify(storedHash, normalized, {
      algorithm: Algorithm.Argon2id,
    });
  } catch {
    return false;
  }
}
