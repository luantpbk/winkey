import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/utils/pagination.js';

describe('Pagination Keyset Cursors', () => {
  it('encodes and decodes JSON objects to and from base64url', () => {
    const payload = {
      t: '2026-10-30T08:00:00.000Z',
      id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
    };

    const encoded = encodeCursor(payload);
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');

    const decoded = decodeCursor<typeof payload>(encoded);
    expect(decoded).toEqual(payload);
  });

  it('returns null on invalid base64 or non-JSON payloads', () => {
    expect(decodeCursor('!!!invalid-base64url!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('not json', 'utf8').toString('base64url'))).toBeNull();
  });
});
