import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * OWASP baseline parameters for argon2id:
 * m=19456 KiB, t=2, p=1
 */
export const ARGON2_CONFIG = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: Algorithm.Argon2id,
};

/**
 * Hashes a plaintext password using argon2id with OWASP baseline parameters.
 */
export async function hashPassword(password: string): Promise<string> {
  return await hash(password, ARGON2_CONFIG);
}

/**
 * Verifies a plaintext password against a stored PHC hash string.
 */
export async function verifyPassword(passwordHash: string, candidate: string): Promise<boolean> {
  try {
    return await verify(passwordHash, candidate, {
      algorithm: Algorithm.Argon2id,
    });
  } catch {
    return false;
  }
}

/**
 * Checks if the existing hash was generated with older or different parameters.
 * PHC string format: $argon2id$v=19$m=19456,t=2,p=1$...
 */
export function needsRehash(passwordHash: string): boolean {
  if (!passwordHash.startsWith('$argon2id$')) {
    return true;
  }

  // Parse parameters $argon2id$v=19$m=19456,t=2,p=1$...
  const parts = passwordHash.split('$');
  // parts: ["", "argon2id", "v=19", "m=19456,t=2,p=1", ...]
  if (parts.length < 5) return true;

  const paramsStr = parts[3]; // "m=19456,t=2,p=1"
  const params: Record<string, number> = {};
  for (const item of paramsStr.split(',')) {
    const [k, v] = item.split('=');
    if (k && v) {
      params[k] = parseInt(v, 10);
    }
  }

  return (
    params['m'] !== ARGON2_CONFIG.memoryCost ||
    params['t'] !== ARGON2_CONFIG.timeCost ||
    params['p'] !== ARGON2_CONFIG.parallelism
  );
}
