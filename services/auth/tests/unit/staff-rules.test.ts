import { describe, it, expect } from 'vitest';
import { computeEffectiveRoles } from '../../src/security/staff-rules.js';

describe('Staff 2FA enforcement rule (ADR-049)', () => {
  it('strips moderator and admin roles when STAFF_MFA_REQUIRED=true and user has no 2FA', () => {
    const res = computeEffectiveRoles(['admin', 'viewer'], false, true);

    expect(res.effectiveRoles).toEqual(['viewer']);
    expect(res.staffRolesPendingMfa).toEqual(['admin']);
  });

  it('strips both admin and moderator when present without 2FA', () => {
    const res = computeEffectiveRoles(['admin', 'moderator', 'creator'], false, true);

    expect(res.effectiveRoles).toEqual(['creator']);
    expect(res.staffRolesPendingMfa).toEqual(['admin', 'moderator']);
  });

  it('keeps staff roles intact when user has 2FA enabled', () => {
    const res = computeEffectiveRoles(['admin', 'viewer'], true, true);

    expect(res.effectiveRoles).toEqual(['admin', 'viewer']);
    expect(res.staffRolesPendingMfa).toEqual([]);
  });

  it('does not alter non-staff roles when 2FA is absent', () => {
    const res = computeEffectiveRoles(['creator', 'viewer'], false, true);

    expect(res.effectiveRoles).toEqual(['creator', 'viewer']);
    expect(res.staffRolesPendingMfa).toEqual([]);
  });

  it('leaves staff roles unchanged when STAFF_MFA_REQUIRED=false even without 2FA', () => {
    const res = computeEffectiveRoles(['admin', 'moderator', 'viewer'], false, false);

    expect(res.effectiveRoles).toEqual(['admin', 'moderator', 'viewer']);
    expect(res.staffRolesPendingMfa).toEqual([]);
  });
});
