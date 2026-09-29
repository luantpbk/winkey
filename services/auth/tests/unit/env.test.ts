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
