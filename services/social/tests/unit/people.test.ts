import { describe, it, expect } from 'vitest';
import { escapeLike, normalizePeopleQuery } from '../../src/routes/people.js';

describe('people search helpers (Task SOC-6a)', () => {
  it('normalizePeopleQuery trims, drops one leading @ and enforces 1–64 characters', () => {
    expect(normalizePeopleQuery('  tuan ')).toBe('tuan');
    expect(normalizePeopleQuery('@tuan_anh')).toBe('tuan_anh');
    expect(normalizePeopleQuery('@ tuan')).toBe('tuan');
    expect(normalizePeopleQuery('@@x')).toBe('@x');
    expect(normalizePeopleQuery('')).toBeNull();
    expect(normalizePeopleQuery('   ')).toBeNull();
    expect(normalizePeopleQuery('@')).toBeNull();
    expect(normalizePeopleQuery(undefined)).toBeNull();
    expect(normalizePeopleQuery(['a', 'b'])).toBeNull();
    expect(normalizePeopleQuery('x'.repeat(64))).toBe('x'.repeat(64));
    expect(normalizePeopleQuery('x'.repeat(65))).toBeNull();
    // Counted in characters, not UTF-16 units: 64 emoji are allowed.
    expect(normalizePeopleQuery('😀'.repeat(64))).toBe('😀'.repeat(64));
  });

  it('escapeLike makes %, _ and the escape character literal', () => {
    expect(escapeLike('tuan')).toBe('tuan');
    expect(escapeLike('50%_off!')).toBe('50!%!_off!!');
    expect(escapeLike('a\\b')).toBe('a\\b');
  });
});
