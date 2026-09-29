import crypto from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Env } from '../config/env.js';

export const REFRESH_COOKIE_NAME = 'wk_rt';
export const REFRESH_TOKEN_TTL_SECONDS = 2592000; // 30 days in seconds

/**
 * Generates 32 cryptographically secure random bytes encoded as base64url.
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Computes SHA-256 binary hash of the opaque token string.
 * The stored token_hash is bytea with octet_length = 32.
 */
export function hashRefreshToken(token: string): Buffer {
  return crypto.createHash('sha256').update(token).digest();
}

/**
 * Cookie options for the refresh token cookie per ADR-009 and the contract:
 * HttpOnly; Secure (except when NODE_ENV=development); SameSite=Strict; Path=/v1/auth; Max-Age=2592000.
 */
export function getRefreshCookieOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'strict',
    path: '/v1/auth',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  };
}

/**
 * Cookie options for clearing the refresh token cookie.
 */
export function getClearRefreshCookieOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'strict',
    path: '/v1/auth',
    maxAge: 0,
  };
}
