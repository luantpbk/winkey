import { describe, it, expect } from 'vitest';
import { envSchema, getEnv } from '../../src/config/env.js';

describe('Environment Configuration', () => {
  it('parses valid environment with defaults', () => {
    const env = envSchema.parse({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.HTTP_PORT).toBe(8002);
    expect(env.DATABASE_URL).toContain('social_svc');
    expect(env.MEDIA_BASE_URL).toBe('https://media.winkey.vn');
    expect(env.TRUST_PROXY_CIDRS).toBe('10.42.0.0/16,127.0.0.1');
  });

  it('allows overriding values in getEnv', () => {
    const env = getEnv({
      NODE_ENV: 'test',
      HTTP_PORT: 9999,
      DATABASE_URL: 'postgres://custom:custom@localhost:5432/test',
    });
    expect(env.NODE_ENV).toBe('test');
    expect(env.HTTP_PORT).toBe(9999);
    expect(env.DATABASE_URL).toBe('postgres://custom:custom@localhost:5432/test');
  });
});
