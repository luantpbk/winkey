import { describe, it, expect } from 'vitest';
import {
  canonicalJsonStringify,
  buildDeviceKeysPayload,
  buildOneTimeKeyPayload,
} from '../../src/lib/e2ee/canonical';

describe('Canonical JSON serializer (ADR-049 / SOC-3a)', () => {
  it('sorts keys lexicographically and strips whitespace', () => {
    const input = {
      zebra: 'stripes',
      alpha: 1,
      charlie: {
        bravo: true,
        apple: null,
      },
      list: [3, 1, 2],
    };

    const result = canonicalJsonStringify(input);
    expect(result).toBe(
      '{"alpha":1,"charlie":{"apple":null,"bravo":true},"list":[3,1,2],"zebra":"stripes"}',
    );
  });

  it('formats device keys canonical JSON matching contract exactly', () => {
    const payload = buildDeviceKeysPayload({
      userId: 'user-uuid-123',
      deviceId: 'dev-uuid-456',
      curve25519: 'CURVE_KEY_BASE64',
      ed25519: 'ED_KEY_BASE64',
    });

    // Contract specification:
    // {"algorithms":["m.megolm.v1.aes-sha2","m.olm.v1.curve25519-aes-sha2"],"curve25519":K,"device_id":D,"ed25519":E,"user_id":U}
    expect(payload).toBe(
      '{"algorithms":["m.megolm.v1.aes-sha2","m.olm.v1.curve25519-aes-sha2"],"curve25519":"CURVE_KEY_BASE64","device_id":"dev-uuid-456","ed25519":"ED_KEY_BASE64","user_id":"user-uuid-123"}',
    );
  });

  it('formats one-time and fallback key canonical JSON matching contract exactly', () => {
    const otk = buildOneTimeKeyPayload({
      deviceId: 'dev-1',
      keyId: 'otk-1',
      key: 'KEY_BASE64',
      fallback: false,
    });
    expect(otk).toBe('{"device_id":"dev-1","fallback":false,"key":"KEY_BASE64","key_id":"otk-1"}');

    const fallback = buildOneTimeKeyPayload({
      deviceId: 'dev-1',
      keyId: 'fb-1',
      key: 'FALLBACK_KEY_BASE64',
      fallback: true,
    });
    expect(fallback).toBe(
      '{"device_id":"dev-1","fallback":true,"key":"FALLBACK_KEY_BASE64","key_id":"fb-1"}',
    );
  });
});
