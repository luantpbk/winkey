import crypto from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Env } from '../config/env.js';

export const OAUTH_COOKIE_NAME = 'wk_oauth';

export interface OAuthSessionState {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Creates an HMAC signed string: "payloadBase64.signatureBase64"
 */
export function signOAuthPayload(payload: OAuthSessionState, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${hmac}`;
}

/**
 * Verifies and parses an HMAC signed string.
 */
export function verifyOAuthPayload(token: string, secret: string): OAuthSessionState | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [data, signature] = parts;
  const expectedHmac = crypto.createHmac('sha256', secret).update(data).digest('base64url');

  if (signature.length !== expectedHmac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHmac))) {
    return null;
  }

  try {
    const jsonStr = Buffer.from(data, 'base64url').toString('utf8');
    return JSON.parse(jsonStr) as OAuthSessionState;
  } catch {
    return null;
  }
}

export function getOAuthCookieOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/v1/auth/oauth/google/callback',
    maxAge: 600, // 10 minutes
  };
}

export function getClearOAuthCookieOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/v1/auth/oauth/google/callback',
    maxAge: 0,
  };
}
