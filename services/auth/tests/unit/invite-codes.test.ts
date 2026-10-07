import { describe, it, expect } from 'vitest';
import { checkInvite } from '../../src/tokens/invite-codes.js';
import { envSchema } from '../../src/config/env.js';

describe('checkInvite', () => {
  const validBase = {
    JWT_PRIVATE_KEY: 'test-key',
  };

  it('always succeeds in open mode even with missing or invalid code', () => {
    const openEnv = envSchema.parse({
      ...validBase,
      REGISTRATION_MODE: 'open',
    });

    expect(checkInvite(openEnv, undefined)).toEqual({ ok: true, index: null });
    expect(checkInvite(openEnv, '')).toEqual({ ok: true, index: null });
    expect(checkInvite(openEnv, 'any-random-code')).toEqual({ ok: true, index: null });
  });

  describe('invite mode', () => {
    const code1 = 'alpha-invite-code-1234';
    const code2 = 'bravo-invite-code-5678';
    const inviteEnv = envSchema.parse({
      ...validBase,
      REGISTRATION_MODE: 'invite',
      INVITE_CODES: `${code1},${code2}`,
    });

    it('returns INVITE_REQUIRED when code is missing or empty', () => {
      expect(checkInvite(inviteEnv, undefined)).toEqual({
        ok: false,
        reason: 'INVITE_REQUIRED',
      });
      expect(checkInvite(inviteEnv, '')).toEqual({
        ok: false,
        reason: 'INVITE_REQUIRED',
      });
      expect(checkInvite(inviteEnv, '   ')).toEqual({
        ok: false,
        reason: 'INVITE_REQUIRED',
      });
    });

    it('returns INVITE_INVALID when code does not match any configured code', () => {
      expect(checkInvite(inviteEnv, 'wrong-invite-code-9999')).toEqual({
        ok: false,
        reason: 'INVITE_INVALID',
      });
    });

    it('returns ok and index 0 when first code matches', () => {
      expect(checkInvite(inviteEnv, code1)).toEqual({
        ok: true,
        index: 0,
      });
    });

    it('returns ok and index 1 when second code matches', () => {
      expect(checkInvite(inviteEnv, code2)).toEqual({
        ok: true,
        index: 1,
      });
    });
  });
});
