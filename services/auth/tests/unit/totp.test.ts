import { describe, it, expect } from 'vitest';
import {
  generateTotpSecret,
  matchTotpStep,
  generateTotpCode,
  buildOtpauthUri,
} from '../../src/crypto/totp.js';

describe('TOTP RFC 6238 implementation', () => {
  it('generates base32 secret of specified length', () => {
    const secret = generateTotpSecret();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThanOrEqual(16);
    // Base32 character set
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  });

  it('matches valid 6-digit TOTP code and returns step', () => {
    const secret = generateTotpSecret();
    const nowSec = Math.floor(Date.now() / 1000);
    const code = generateTotpCode(secret, nowSec);

    const step = matchTotpStep(secret, code, nowSec);
    expect(step).not.toBeNull();
    expect(typeof step).toBe('bigint');
    const expectedStep = BigInt(Math.floor(nowSec / 30));
    const diff = step! > expectedStep ? step! - expectedStep : expectedStep - step!;
    expect(diff <= 1n).toBe(true);
  });

  it('accepts codes within +/- 1 step tolerance window', () => {
    const secret = generateTotpSecret();
    const nowSec = 1700000000;
    // Current step
    const currentCode = generateTotpCode(secret, nowSec);
    expect(matchTotpStep(secret, currentCode, nowSec)).not.toBeNull();

    // Previous step (-30s)
    const prevCode = generateTotpCode(secret, nowSec - 30);
    expect(matchTotpStep(secret, prevCode, nowSec)).not.toBeNull();

    // Next step (+30s)
    const nextCode = generateTotpCode(secret, nowSec + 30);
    expect(matchTotpStep(secret, nextCode, nowSec)).not.toBeNull();

    // Far away (+90s)
    const farCode = generateTotpCode(secret, nowSec + 90);
    expect(matchTotpStep(secret, farCode, nowSec)).toBeNull();
  });

  it('rejects invalid or wrong format codes', () => {
    const secret = generateTotpSecret();
    expect(matchTotpStep(secret, '12345')).toBeNull(); // 5 digits
    expect(matchTotpStep(secret, '1234567')).toBeNull(); // 7 digits
    expect(matchTotpStep(secret, 'abcdef')).toBeNull(); // letters
    expect(matchTotpStep(secret, '000000')).toBeNull(); // wrong code
  });

  it('builds otpauth URI with label and issuer', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const uri = buildOtpauthUri('user@winkey.vn', secret, 'Winkey');
    expect(uri).toContain('otpauth://totp/Winkey:user%40winkey.vn');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Winkey');
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
  });
});
