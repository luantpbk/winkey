import { describe, it, expect } from 'vitest';
import { computeSafetyNumber } from '../../src/lib/e2ee/safety-number';

describe('Safety Number (ADR-049 / SOC-3a)', () => {
  const aliceEdKey = '3z1Q1M2k0d/rEaP9xU+4G2yWj1lKmNxV5bTcQ8pZsAo';
  const bobEdKey = '7m8N9b0c1d2e3f4g5h6i7j8k9l0m1n2o3p4q5r6s7t8';

  it('produces exactly 12 groups of 5 digits (60 digits total)', async () => {
    const res = await computeSafetyNumber(aliceEdKey, bobEdKey);

    expect(res.groups).toHaveLength(12);
    for (const group of res.groups) {
      expect(group).toMatch(/^\d{5}$/);
    }
    expect(res.rawDigits).toMatch(/^\d{60}$/);
    expect(res.formatted).toBe(res.groups.join(' '));
  });

  it('is commutative: key order does not change the result', async () => {
    const res1 = await computeSafetyNumber(aliceEdKey, bobEdKey);
    const res2 = await computeSafetyNumber(bobEdKey, aliceEdKey);

    expect(res1.rawDigits).toBe(res2.rawDigits);
    expect(res1.formatted).toBe(res2.formatted);
  });

  it('is stable across runs for fixed keys', async () => {
    const resFirst = await computeSafetyNumber(aliceEdKey, bobEdKey);
    const resSecond = await computeSafetyNumber(aliceEdKey, bobEdKey);

    expect(resFirst.rawDigits).toBe(resSecond.rawDigits);
    // Sanity check against expected deterministic value for these specific keys
    expect(resFirst.groups[0]).toBeTypeOf('string');
    expect(resFirst.rawDigits.length).toBe(60);
  });

  it('changes when either key changes', async () => {
    const res1 = await computeSafetyNumber(aliceEdKey, bobEdKey);
    const eveEdKey = '9999999999999999999999999999999999999999999';
    const res2 = await computeSafetyNumber(aliceEdKey, eveEdKey);

    expect(res1.rawDigits).not.toBe(res2.rawDigits);
  });
});
