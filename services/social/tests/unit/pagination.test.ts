import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/utils/pagination.js';

describe('Pagination Cursors', () => {
  it('encodes and decodes pagination cursor correctly', () => {
    const original = {
      created_at: '2026-09-29T12:00:00.000Z',
      id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
    };
    const encoded = encodeCursor(original);
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toContain('{');

    const decoded = decodeCursor<typeof original>(encoded);
    expect(decoded).toEqual(original);
  });

  it('returns null on invalid base64 cursor', () => {
    const invalid = decodeCursor('this-is-not-valid-json');
    expect(invalid).toBeNull();
  });
});
