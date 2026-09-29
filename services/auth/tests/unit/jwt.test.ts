import { describe, it, expect, beforeEach } from 'vitest';
import { issueAccessToken, verifyAccessToken, getJwks, resetKeyCache } from '../../src/crypto/jwt.js';
import { getTestKeys } from '../fixtures/keys.js';
import { getEnv } from '../../src/config/env.js';
import { SignJWT, importPKCS8 } from 'jose';
import { v7 as uuidv7 } from 'uuid';

describe('jwt (RS256 & JWKS)', () => {
  beforeEach(() => {
    resetKeyCache();
  });
  const keys = getTestKeys();
  const env = getEnv({
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_KID: 'winkey-key-active',
    JWT_PREVIOUS_PUBLIC_KEY: keys.previousPublicKey,
    JWT_ISSUER: 'https://winkey.vn',
  });

  const sampleUser = {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d',
    roles: ['viewer' as const, 'creator' as const],
  };
  const sampleFamilyId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0e';

  it('issues a valid 15-minute RS256 access token with proper claims', async () => {
    const { token, expiresIn } = await issueAccessToken(sampleUser, sampleFamilyId, env);

    expect(expiresIn).toBe(900);
    expect(typeof token).toBe('string');

    const claims = await verifyAccessToken(token, env);
    expect(claims.sub).toBe(sampleUser.id);
    expect(claims.roles).toEqual(sampleUser.roles);
    expect(claims.sid).toBe(sampleFamilyId);
    expect(claims.iss).toBe('https://winkey.vn');
    expect(claims.aud).toBe('winkey-api');
    expect(claims.jti).toBeDefined();
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('verifies token signed with previous key during rotation', async () => {
    const prevPrivateKey = await importPKCS8(keys.previousPrivateKey, 'RS256');
    const prevToken = await new SignJWT({
      roles: sampleUser.roles,
      sid: sampleFamilyId,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'winkey-key-active-prev' })
      .setIssuedAt()
      .setIssuer('https://winkey.vn')
      .setAudience('winkey-api')
      .setSubject(sampleUser.id)
      .setExpirationTime('15m')
      .setJti(uuidv7())
      .sign(prevPrivateKey);

    const claims = await verifyAccessToken(prevToken, env);
    expect(claims.sub).toBe(sampleUser.id);
  });

  it('rejects tampered token', async () => {
    const { token } = await issueAccessToken(sampleUser, sampleFamilyId, env);
    // Tamper payload by replacing characters in signature
    const parts = token.split('.');
    const tamperedToken = `${parts[0]}.${parts[1]}.tamperedSignatureHere`;

    await expect(verifyAccessToken(tamperedToken, env)).rejects.toThrow();
  });

  it('rejects token with wrong key / unknown kid', async () => {
    // Generate unrelated key
    const unrelatedKey = getTestKeys().previousPrivateKey;
    const key = await importPKCS8(unrelatedKey, 'RS256');

    // Create env without previous public key
    const isolatedEnv = getEnv({
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_KID: 'isolated-key',
      JWT_PREVIOUS_PUBLIC_KEY: undefined,
    });

    const foreignToken = await new SignJWT({ roles: ['viewer'], sid: sampleFamilyId })
      .setProtectedHeader({ alg: 'RS256', kid: 'foreign-key' })
      .setIssuer(env.JWT_ISSUER)
      .setAudience('winkey-api')
      .setSubject(sampleUser.id)
      .setExpirationTime('15m')
      .sign(key);

    await expect(verifyAccessToken(foreignToken, isolatedEnv)).rejects.toThrow();
  });

  it('returns valid JWKS containing active and previous public keys', async () => {
    const jwks = await getJwks(env);
    expect(jwks.keys).toBeDefined();
    expect(jwks.keys.length).toBe(2);

    const activeJwk = jwks.keys.find((k) => k.kid === 'winkey-key-active');
    expect(activeJwk).toBeDefined();
    expect(activeJwk?.kty).toBe('RSA');
    expect(activeJwk?.alg).toBe('RS256');
    expect(activeJwk?.use).toBe('sig');
    expect(activeJwk?.n).toBeDefined();
    expect(activeJwk?.e).toBeDefined();
  });
});
