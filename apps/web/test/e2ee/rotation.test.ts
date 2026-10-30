import { describe, it, expect } from 'vitest';
import {
  shouldRotateMegolmSession,
  MAX_MEGOLM_SESSION_AGE_MS,
  type OutboundSessionMetadata,
} from '../../src/lib/e2ee/rotation';

describe('Megolm Outbound Session Rotation Triggers (ADR-049 / SOC-3a)', () => {
  const baseTime = 1700000000000;

  function makeSession(overrides: Partial<OutboundSessionMetadata> = {}): OutboundSessionMetadata {
    return {
      sessionId: 'session-xyz-123',
      messageIndex: 0,
      createdAt: baseTime,
      ...overrides,
    };
  }

  it('triggers rotation if no session exists', () => {
    const res = shouldRotateMegolmSession(null);
    expect(res.shouldRotate).toBe(true);
    expect(res.reason).toBeNull();
  });

  it('does not rotate fresh session with few messages', () => {
    const session = makeSession({ messageIndex: 10 });
    const res = shouldRotateMegolmSession(session, { now: baseTime + 1000 });
    expect(res.shouldRotate).toBe(false);
    expect(res.reason).toBeNull();
  });

  it('rotates after 100 messages', () => {
    const session99 = makeSession({ messageIndex: 99 });
    expect(shouldRotateMegolmSession(session99, { now: baseTime + 1000 }).shouldRotate).toBe(false);

    const session100 = makeSession({ messageIndex: 100 });
    const res100 = shouldRotateMegolmSession(session100, { now: baseTime + 1000 });
    expect(res100.shouldRotate).toBe(true);
    expect(res100.reason).toBe('MESSAGE_LIMIT');

    const session105 = makeSession({ messageIndex: 105 });
    expect(shouldRotateMegolmSession(session105, { now: baseTime + 1000 }).reason).toBe(
      'MESSAGE_LIMIT',
    );
  });

  it('rotates after 7 days (604,800,000 ms)', () => {
    const session = makeSession();

    // 6 days later: no rotation
    const sixDaysLater = baseTime + 6 * 24 * 60 * 60 * 1000;
    expect(shouldRotateMegolmSession(session, { now: sixDaysLater }).shouldRotate).toBe(false);

    // Exactly 7 days later: rotate
    const sevenDaysLater = baseTime + MAX_MEGOLM_SESSION_AGE_MS;
    const res = shouldRotateMegolmSession(session, { now: sevenDaysLater });
    expect(res.shouldRotate).toBe(true);
    expect(res.reason).toBe('AGE_LIMIT');
  });

  it('rotates immediately on membership changes', () => {
    const session = makeSession({ messageIndex: 1 });
    const res = shouldRotateMegolmSession(session, {
      now: baseTime + 1000,
      membershipChanged: true,
    });
    expect(res.shouldRotate).toBe(true);
    expect(res.reason).toBe('MEMBERSHIP_CHANGED');
  });

  it('rotates immediately on device list changes (chat.hint DEVICES)', () => {
    const session = makeSession({ messageIndex: 1 });
    const res = shouldRotateMegolmSession(session, { now: baseTime + 1000, devicesChanged: true });
    expect(res.shouldRotate).toBe(true);
    expect(res.reason).toBe('DEVICES_CHANGED');
  });
});
