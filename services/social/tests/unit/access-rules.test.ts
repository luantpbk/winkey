import { describe, it, expect } from 'vitest';
import {
  isVideoClosedForCaller,
  type VideoAccessTarget,
  type CallerIdentity,
} from '../../src/utils/auth.js';

describe('isVideoClosedForCaller - Access Rule Matrix (Task C4 & A2)', () => {
  const OWNER_ID = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
  const OTHER_ID = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002';

  const callers: Record<string, CallerIdentity> = {
    owner: {
      userId: OWNER_ID,
      roles: ['viewer'],
      isModeratorOrAdmin: false,
    },
    moderator: {
      userId: OTHER_ID,
      roles: ['moderator'],
      isModeratorOrAdmin: true,
    },
    admin: {
      userId: OTHER_ID,
      roles: ['admin'],
      isModeratorOrAdmin: true,
    },
    other: {
      userId: OTHER_ID,
      roles: ['viewer'],
      isModeratorOrAdmin: false,
    },
    anonymous: {
      userId: null,
      roles: [],
      isModeratorOrAdmin: false,
    },
  };

  interface MatrixTestCase {
    hidden: boolean;
    visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE' | null | undefined;
    callerType: keyof typeof callers;
    expectedClosed: boolean;
    description: string;
  }

  const testCases: MatrixTestCase[] = [
    // 1. PUBLIC, not hidden: Open to all
    {
      hidden: false,
      visibility: 'PUBLIC',
      callerType: 'owner',
      expectedClosed: false,
      description: 'PUBLIC video: owner can access',
    },
    {
      hidden: false,
      visibility: 'PUBLIC',
      callerType: 'moderator',
      expectedClosed: false,
      description: 'PUBLIC video: moderator can access',
    },
    {
      hidden: false,
      visibility: 'PUBLIC',
      callerType: 'admin',
      expectedClosed: false,
      description: 'PUBLIC video: admin can access',
    },
    {
      hidden: false,
      visibility: 'PUBLIC',
      callerType: 'other',
      expectedClosed: false,
      description: 'PUBLIC video: other viewer can access',
    },
    {
      hidden: false,
      visibility: 'PUBLIC',
      callerType: 'anonymous',
      expectedClosed: false,
      description: 'PUBLIC video: anonymous user can access',
    },

    // 2. UNLISTED, not hidden: Behaves like PUBLIC (open to anyone with the link)
    {
      hidden: false,
      visibility: 'UNLISTED',
      callerType: 'owner',
      expectedClosed: false,
      description: 'UNLISTED video: owner can access',
    },
    {
      hidden: false,
      visibility: 'UNLISTED',
      callerType: 'moderator',
      expectedClosed: false,
      description: 'UNLISTED video: moderator can access',
    },
    {
      hidden: false,
      visibility: 'UNLISTED',
      callerType: 'admin',
      expectedClosed: false,
      description: 'UNLISTED video: admin can access',
    },
    {
      hidden: false,
      visibility: 'UNLISTED',
      callerType: 'other',
      expectedClosed: false,
      description: 'UNLISTED video: other viewer can access',
    },
    {
      hidden: false,
      visibility: 'UNLISTED',
      callerType: 'anonymous',
      expectedClosed: false,
      description: 'UNLISTED video: anonymous user can access',
    },

    // 3. PRIVATE, not hidden: Closed to outsiders, open to owner / moderator / admin
    {
      hidden: false,
      visibility: 'PRIVATE',
      callerType: 'owner',
      expectedClosed: false,
      description: 'PRIVATE video: owner can access',
    },
    {
      hidden: false,
      visibility: 'PRIVATE',
      callerType: 'moderator',
      expectedClosed: false,
      description: 'PRIVATE video: moderator can access',
    },
    {
      hidden: false,
      visibility: 'PRIVATE',
      callerType: 'admin',
      expectedClosed: false,
      description: 'PRIVATE video: admin can access',
    },
    {
      hidden: false,
      visibility: 'PRIVATE',
      callerType: 'other',
      expectedClosed: true,
      description: 'PRIVATE video: other viewer is closed (404)',
    },
    {
      hidden: false,
      visibility: 'PRIVATE',
      callerType: 'anonymous',
      expectedClosed: true,
      description: 'PRIVATE video: anonymous user is closed (404)',
    },

    // 4. HIDDEN (moderated), PUBLIC visibility: Closed to all except moderator / admin
    {
      hidden: true,
      visibility: 'PUBLIC',
      callerType: 'owner',
      expectedClosed: true,
      description: 'HIDDEN video (PUBLIC): owner is closed (404)',
    },
    {
      hidden: true,
      visibility: 'PUBLIC',
      callerType: 'moderator',
      expectedClosed: false,
      description: 'HIDDEN video (PUBLIC): moderator can access',
    },
    {
      hidden: true,
      visibility: 'PUBLIC',
      callerType: 'admin',
      expectedClosed: false,
      description: 'HIDDEN video (PUBLIC): admin can access',
    },
    {
      hidden: true,
      visibility: 'PUBLIC',
      callerType: 'other',
      expectedClosed: true,
      description: 'HIDDEN video (PUBLIC): other viewer is closed (404)',
    },
    {
      hidden: true,
      visibility: 'PUBLIC',
      callerType: 'anonymous',
      expectedClosed: true,
      description: 'HIDDEN video (PUBLIC): anonymous user is closed (404)',
    },

    // 5. HIDDEN (moderated), UNLISTED visibility: Closed to all except moderator / admin
    {
      hidden: true,
      visibility: 'UNLISTED',
      callerType: 'owner',
      expectedClosed: true,
      description: 'HIDDEN video (UNLISTED): owner is closed (404)',
    },
    {
      hidden: true,
      visibility: 'UNLISTED',
      callerType: 'moderator',
      expectedClosed: false,
      description: 'HIDDEN video (UNLISTED): moderator can access',
    },
    {
      hidden: true,
      visibility: 'UNLISTED',
      callerType: 'admin',
      expectedClosed: false,
      description: 'HIDDEN video (UNLISTED): admin can access',
    },
    {
      hidden: true,
      visibility: 'UNLISTED',
      callerType: 'other',
      expectedClosed: true,
      description: 'HIDDEN video (UNLISTED): other viewer is closed (404)',
    },
    {
      hidden: true,
      visibility: 'UNLISTED',
      callerType: 'anonymous',
      expectedClosed: true,
      description: 'HIDDEN video (UNLISTED): anonymous user is closed (404)',
    },

    // 6. HIDDEN (moderated), PRIVATE visibility: Closed to all except moderator / admin
    {
      hidden: true,
      visibility: 'PRIVATE',
      callerType: 'owner',
      expectedClosed: true,
      description: 'HIDDEN + PRIVATE video: owner is closed (404)',
    },
    {
      hidden: true,
      visibility: 'PRIVATE',
      callerType: 'moderator',
      expectedClosed: false,
      description: 'HIDDEN + PRIVATE video: moderator can access',
    },
    {
      hidden: true,
      visibility: 'PRIVATE',
      callerType: 'admin',
      expectedClosed: false,
      description: 'HIDDEN + PRIVATE video: admin can access',
    },
    {
      hidden: true,
      visibility: 'PRIVATE',
      callerType: 'other',
      expectedClosed: true,
      description: 'HIDDEN + PRIVATE video: other viewer is closed (404)',
    },
    {
      hidden: true,
      visibility: 'PRIVATE',
      callerType: 'anonymous',
      expectedClosed: true,
      description: 'HIDDEN + PRIVATE video: anonymous user is closed (404)',
    },

    // 7. Visibility undefined / null (rows projected before C4 default to PUBLIC behaviour)
    {
      hidden: false,
      visibility: undefined,
      callerType: 'other',
      expectedClosed: false,
      description: 'undefined visibility: behaves as PUBLIC',
    },
    {
      hidden: false,
      visibility: null,
      callerType: 'other',
      expectedClosed: false,
      description: 'null visibility: behaves as PUBLIC',
    },
    {
      hidden: true,
      visibility: undefined,
      callerType: 'other',
      expectedClosed: true,
      description: 'undefined visibility + hidden: is closed',
    },
  ];

  for (const tc of testCases) {
    it(tc.description, () => {
      const video: VideoAccessTarget = {
        owner_id: OWNER_ID,
        hidden: tc.hidden,
        visibility: tc.visibility,
      };
      const caller = callers[tc.callerType];
      const isClosed = isVideoClosedForCaller(video, caller);
      expect(isClosed).toBe(tc.expectedClosed);
    });
  }
});
