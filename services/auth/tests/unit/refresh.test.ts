import { describe, it, expect } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  getRefreshCookieOptions,
  getClearRefreshCookieOptions,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../../src/crypto/refresh.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';

describe('refresh crypto & cookie settings', () => {
  const keys = getTestKeys();

  it('generates 32-byte random base64url tokens', () => {
    const token = generateRefreshToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(42);
    // Base64url characters only
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes token with SHA-256 producing 32-byte binary Buffer', () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);

    expect(Buffer.isBuffer(hash)).toBe(true);
    expect(hash.length).toBe(32);

    // Hash must be deterministic
    const hash2 = hashRefreshToken(token);
    expect(hash.equals(hash2)).toBe(true);
  });

  it('configures wk_rt cookie per contract and ADR-009', () => {
    const prodEnv = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      NODE_ENV: 'production',
      COOKIE_SECRET: 'super-secure-production-cookie-secret-min-32-chars-long!',
    });

    const cookieOpts = getRefreshCookieOptions(prodEnv);
    expect(REFRESH_COOKIE_NAME).toBe('wk_rt');
    expect(cookieOpts.httpOnly).toBe(true);
    expect(cookieOpts.secure).toBe(true);
    expect(cookieOpts.sameSite).toBe('strict');
    expect(cookieOpts.path).toBe('/v1/auth');
    expect(cookieOpts.maxAge).toBe(2592000);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(2592000);

    const devEnv = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      NODE_ENV: 'development',
    });
    const devCookieOpts = getRefreshCookieOptions(devEnv);
    expect(devCookieOpts.secure).toBe(false);
  });

  it('clears cookie with maxAge=0', () => {
    const env = getEnv({ JWT_PRIVATE_KEY: keys.privateKey });
    const clearOpts = getClearRefreshCookieOptions(env);
    expect(clearOpts.maxAge).toBe(0);
    expect(clearOpts.path).toBe('/v1/auth');
  });
});
