import { importPKCS8, importSPKI, exportJWK, SignJWT, jwtVerify, type JWK } from 'jose';
import type { KeyObject } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Env } from '../config/env.js';
import type { Role } from '../db/types.js';

export type KeyLike = Awaited<ReturnType<typeof importSPKI>> | KeyObject | Uint8Array;

export interface AccessTokenPayload {
  sub: string;
  roles: Role[];
  sid: string;
  [key: string]: unknown;
}

export interface AccessTokenClaims {
  sub: string;
  roles: Role[];
  sid: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

interface KeyCache {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: JWK;
  previousPublicKey?: KeyLike;
  previousPublicJwk?: JWK;
}

let keyCache: KeyCache | null = null;

export function resetKeyCache(): void {
  keyCache = null;
}

/**
 * Initializes and caches the cryptographic RSA keys in memory for fast stateless verification.
 */
export async function initializeKeys(env: Env): Promise<KeyCache> {
  if (keyCache) return keyCache;

  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256', { extractable: true });
  // Derive public key JWK
  const privateJwk = await exportJWK(privateKey);
  const publicJwk: JWK = {
    kty: privateJwk.kty,
    n: privateJwk.n,
    e: privateJwk.e,
    alg: 'RS256',
    use: 'sig',
    kid: env.JWT_KID,
  };

  const publicKey = await importSPKI(await jwkToSpki(publicJwk), 'RS256');

  let previousPublicKey: KeyLike | undefined;
  let previousPublicJwk: JWK | undefined;

  if (env.JWT_PREVIOUS_PUBLIC_KEY) {
    try {
      previousPublicKey = await importSPKI(env.JWT_PREVIOUS_PUBLIC_KEY, 'RS256');
      const prevJwk = await exportJWK(previousPublicKey);
      previousPublicJwk = {
        ...prevJwk,
        alg: 'RS256',
        use: 'sig',
        kid: `${env.JWT_KID}-prev`,
      };
    } catch (e) {
      console.warn('Failed to import JWT_PREVIOUS_PUBLIC_KEY:', e);
    }
  }

  keyCache = {
    privateKey,
    publicKey,
    publicJwk,
    previousPublicKey,
    previousPublicJwk,
  };

  return keyCache;
}

async function jwkToSpki(jwk: JWK): Promise<string> {
  const { exportSPKI, importJWK } = await import('jose');
  const key = await importJWK(jwk, 'RS256');
  return await exportSPKI(key as Parameters<typeof exportSPKI>[0]);
}

/**
 * Issues an RS256 Access Token valid for 15 minutes (900 seconds).
 */
export async function issueAccessToken(
  user: { id: string; roles: Role[] },
  familyId: string,
  env: Env,
): Promise<{ token: string; expiresIn: number }> {
  const keys = await initializeKeys(env);
  const expiresIn = 900; // 15 minutes in seconds

  const token = await new SignJWT({
    roles: user.roles,
    sid: familyId,
  })
    .setProtectedHeader({ alg: 'RS256', kid: env.JWT_KID })
    .setIssuedAt()
    .setIssuer(env.JWT_ISSUER)
    .setAudience('winkey-api')
    .setSubject(user.id)
    .setExpirationTime('15m')
    .setJti(uuidv7())
    .sign(keys.privateKey);

  return { token, expiresIn };
}

/**
 * Verifies an Access Token in-memory. Zero database interaction.
 */
export async function verifyAccessToken(token: string, env: Env): Promise<AccessTokenClaims> {
  const keys = await initializeKeys(env);
  const { decodeProtectedHeader } = await import('jose');
  const header = decodeProtectedHeader(token);

  if (!header.kid) {
    throw new Error('Missing kid in token header');
  }

  let verifyKey: KeyLike;
  if (header.kid === env.JWT_KID) {
    verifyKey = keys.publicKey;
  } else if (keys.previousPublicKey && header.kid === `${env.JWT_KID}-prev`) {
    verifyKey = keys.previousPublicKey;
  } else {
    throw new Error(`Unknown kid '${header.kid}' in token header`);
  }

  const result = await jwtVerify(token, verifyKey, {
    issuer: env.JWT_ISSUER,
    audience: 'winkey-api',
    algorithms: ['RS256'],
  });

  const payload = result.payload;
  return {
    sub: payload.sub as string,
    roles: (payload.roles as Role[]) ?? [],
    sid: payload.sid as string,
    iss: payload.iss as string,
    aud: typeof payload.aud === 'string' ? payload.aud : (payload.aud?.[0] ?? ''),
    iat: payload.iat as number,
    exp: payload.exp as number,
    jti: payload.jti as string,
  };
}

/**
 * Returns the public keys in JWKS format for /.well-known/jwks.json.
 */
export async function getJwks(env: Env): Promise<{ keys: JWK[] }> {
  const keys = await initializeKeys(env);
  const jwksList: JWK[] = [keys.publicJwk];
  if (keys.previousPublicJwk) {
    jwksList.push(keys.previousPublicJwk);
  }
  return { keys: jwksList };
}
