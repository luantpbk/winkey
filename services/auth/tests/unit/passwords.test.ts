import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash, ARGON2_CONFIG } from '../../src/crypto/passwords.js';

describe('passwords (argon2id)', () => {
  it('hashes and verifies a password correctly with OWASP baseline parameters', async () => {
    const password = 'SuperSecretPassword123!';
    const hash = await hashPassword(password);

    expect(hash).toContain('$argon2id$');
    expect(hash).toContain(`m=${ARGON2_CONFIG.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2_CONFIG.timeCost}`);
    expect(hash).toContain(`p=${ARGON2_CONFIG.parallelism}`);

    const isMatch = await verifyPassword(hash, password);
    expect(isMatch).toBe(true);

    const isWrongMatch = await verifyPassword(hash, 'WrongPassword456');
    expect(isWrongMatch).toBe(false);
  });

  it('detects when a hash needs rehash due to parameter change', () => {
    // Current parameters: m=19456, t=2, p=1
    const currentHash = `$argon2id$v=19$m=${ARGON2_CONFIG.memoryCost},t=${ARGON2_CONFIG.timeCost},p=${ARGON2_CONFIG.parallelism}$dummySalt$dummyHash`;
    expect(needsRehash(currentHash)).toBe(false);

    // Older parameters: m=4096
    const oldHash = '$argon2id$v=19$m=4096,t=2,p=1$dummySalt$dummyHash';
    expect(needsRehash(oldHash)).toBe(true);

    // Non-argon2id hash
    const bcryptHash = '$2a$12$e8Njg1zC...';
    expect(needsRehash(bcryptHash)).toBe(true);
  });
});
