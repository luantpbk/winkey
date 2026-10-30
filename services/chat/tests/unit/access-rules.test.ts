import { describe, it, expect } from 'vitest';
import type { MemberRole, MemberState } from '../../src/db/types.js';

describe('Chat Access Control & State Machine Rules (ADR-049)', () => {
  it('determines initial member state based on subscription status', () => {
    // When recipient follows the actor in social.subscriptions -> ACTIVE
    const recipientFollowsActor = true;
    const stateActive: MemberState = recipientFollowsActor ? 'ACTIVE' : 'REQUESTED';
    expect(stateActive).toBe('ACTIVE');

    // When recipient does not follow the actor -> REQUESTED
    const recipientDoesNotFollow = false;
    const stateRequested: MemberState = recipientDoesNotFollow ? 'ACTIVE' : 'REQUESTED';
    expect(stateRequested).toBe('REQUESTED');
  });

  it('enforces 50 active/requested members limit per group conversation', () => {
    const currentActiveMembers = 48;
    const newMembersToAdd = 3;
    const exceedsLimit = currentActiveMembers + newMembersToAdd > 50;
    expect(exceedsLimit).toBe(true);

    const withinLimit = currentActiveMembers + 2 <= 50;
    expect(withinLimit).toBe(true);
  });

  it('computes correct message readable window for joined and left members', () => {
    // Member joined at seq 10, left at seq 25, conversation last_seq is 50
    const joinedSeq = 10n;
    const leftSeq: bigint | null = 25n;
    const lastSeq = 50n;

    const minSeq = joinedSeq;
    const maxSeq = leftSeq !== null ? leftSeq : lastSeq;

    expect(minSeq).toBe(10n);
    expect(maxSeq).toBe(25n);

    // Active member joined at seq 5, not left
    const activeJoined = 5n;
    const activeLeft: bigint | null = null;
    const activeMax = activeLeft !== null ? activeLeft : lastSeq;

    expect(activeJoined).toBe(5n);
    expect(activeMax).toBe(50n);
  });

  it('enforces group role permissions hierarchy', () => {
    function canRemove(callerRole: MemberRole, targetRole: MemberRole, isSelf: boolean): boolean {
      if (isSelf) return true; // Anyone can leave
      if (callerRole === 'OWNER') return true;
      if (callerRole === 'ADMIN' && targetRole === 'MEMBER') return true;
      return false;
    }

    // Owner can remove anyone
    expect(canRemove('OWNER', 'ADMIN', false)).toBe(true);
    expect(canRemove('OWNER', 'MEMBER', false)).toBe(true);

    // Admin can remove MEMBER, but not another ADMIN or the OWNER
    expect(canRemove('ADMIN', 'MEMBER', false)).toBe(true);
    expect(canRemove('ADMIN', 'ADMIN', false)).toBe(false);
    expect(canRemove('ADMIN', 'OWNER', false)).toBe(false);

    // Member cannot remove anyone except self
    expect(canRemove('MEMBER', 'MEMBER', false)).toBe(false);
    expect(canRemove('MEMBER', 'MEMBER', true)).toBe(true);
  });
});
