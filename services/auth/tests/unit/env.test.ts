import { describe, it, expect } from 'vitest';
import { envSchema } from '../../src/config/env.js';

describe('envSchema COOKIE_SECRET validation', () => {
  const validBase = {
    JWT_PRIVATE_KEY: 'test-key',
  };

  it('provides dev default COOKIE_SECRET in development/test', () => {
    const devParsed = envSchema.parse({
      ...validBase,
      NODE_ENV: 'development',
    });
    expect(devParsed.COOKIE_SECRET).toBe('winkey-dev-cookie-secret-min-32-chars-long!');

    const testParsed = envSchema.parse({
      ...validBase,
      NODE_ENV: 'test',
    });
    expect(testParsed.COOKIE_SECRET).toBe('winkey-dev-cookie-secret-min-32-chars-long!');
  });

  it('fails fast when COOKIE_SECRET is missing in production', () => {
    const res = envSchema.safeParse({
      ...validBase,
      NODE_ENV: 'production',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.includes('COOKIE_SECRET'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('COOKIE_SECRET is required when NODE_ENV=production');
    }
  });

  it('fails fast when COOKIE_SECRET uses the dev default in production', () => {
    const res = envSchema.safeParse({
      ...validBase,
      NODE_ENV: 'production',
      COOKIE_SECRET: 'winkey-dev-cookie-secret-min-32-chars-long!',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.includes('COOKIE_SECRET'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('COOKIE_SECRET cannot use the dev default in production');
    }
  });

  it('succeeds when a custom COOKIE_SECRET is provided in production', () => {
    const res = envSchema.safeParse({
      ...validBase,
      NODE_ENV: 'production',
      COOKIE_SECRET: 'prod-secret-must-be-long-and-secure-12345!',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.COOKIE_SECRET).toBe('prod-secret-must-be-long-and-secure-12345!');
    }
  });
});

describe('envSchema REGISTRATION_MODE and INVITE_CODES validation', () => {
  const validBase = {
    JWT_PRIVATE_KEY: 'test-key',
  };

  it('defaults REGISTRATION_MODE to open with empty inviteCodeDigests', () => {
    const parsed = envSchema.parse({
      ...validBase,
    });
    expect(parsed.REGISTRATION_MODE).toBe('open');
    expect(parsed.inviteCodeDigests).toEqual([]);
    expect((parsed as Record<string, unknown>).INVITE_CODES).toBeUndefined();
  });

  it('ignores INVITE_CODES when REGISTRATION_MODE is open', () => {
    const parsed = envSchema.parse({
      ...validBase,
      REGISTRATION_MODE: 'open',
      INVITE_CODES: 'invalid_code_with_underscore',
    });
    expect(parsed.REGISTRATION_MODE).toBe('open');
    expect(parsed.inviteCodeDigests).toEqual([]);
    expect((parsed as Record<string, unknown>).INVITE_CODES).toBeUndefined();
  });

  it('fails fast when INVITE_CODES is missing or empty in invite mode', () => {
    const resMissing = envSchema.safeParse({
      ...validBase,
      REGISTRATION_MODE: 'invite',
    });
    expect(resMissing.success).toBe(false);
    if (!resMissing.success) {
      const issue = resMissing.error.issues.find((i) => i.path.includes('INVITE_CODES'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('INVITE_CODES is required when REGISTRATION_MODE=invite');
    }

    const resEmpty = envSchema.safeParse({
      ...validBase,
      REGISTRATION_MODE: 'invite',
      INVITE_CODES: '   ',
    });
    expect(resEmpty.success).toBe(false);
    if (!resEmpty.success) {
      const issue = resEmpty.error.issues.find((i) => i.path.includes('INVITE_CODES'));
      expect(issue).toBeDefined();
    }
  });

  it('fails fast with invalid code format and never leaks code value in error message', () => {
    const badCode = 'too-short-1'; // 11 chars < 12
    const res = envSchema.safeParse({
      ...validBase,
      REGISTRATION_MODE: 'invite',
      INVITE_CODES: badCode,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const jsonError = JSON.stringify(res.error);
      expect(jsonError).not.toContain(badCode);
      const issue = res.error.issues.find((i) => i.path.includes('INVITE_CODES'));
      expect(issue?.message).toContain('invalid format');
    }
  });

  it('fails fast on duplicate codes and never leaks code value in error message', () => {
    const duplicateCode = 'valid-code-sample-1234';
    const res = envSchema.safeParse({
      ...validBase,
      REGISTRATION_MODE: 'invite',
      INVITE_CODES: `${duplicateCode},valid-code-sample-5678,${duplicateCode}`,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const jsonError = JSON.stringify(res.error);
      expect(jsonError).not.toContain(duplicateCode);
      const issue = res.error.issues.find((i) => i.path.includes('INVITE_CODES'));
      expect(issue?.message).toContain('duplicate codes');
    }
  });

  it('parses valid codes into SHA-256 digests without keeping raw codes in memory', () => {
    const code1 = 'valid-code-sample-1234';
    const code2 = 'valid-code-sample-5678';
    const parsed = envSchema.parse({
      ...validBase,
      REGISTRATION_MODE: 'invite',
      INVITE_CODES: `${code1}, ${code2}`,
    });

    expect(parsed.REGISTRATION_MODE).toBe('invite');
    expect(parsed.inviteCodeDigests).toHaveLength(2);
    expect(Buffer.isBuffer(parsed.inviteCodeDigests[0])).toBe(true);
    expect(Buffer.isBuffer(parsed.inviteCodeDigests[1])).toBe(true);
    expect((parsed as Record<string, unknown>).INVITE_CODES).toBeUndefined();
  });
});
