import { describe, it, expect } from 'vitest';
import { canSeePost, batchCheckCanSeePosts } from '../../src/utils/visibility.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/types.js';

describe('visibility truth table (canSeePost & batchCheckCanSeePosts)', () => {
  const AUTHOR_ID = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9001';
  const VIEWER_ID = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9002';
  const POST_ID = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9003';

  // Helper to create a mocked Kysely instance for visibility checks
  function createMockDb(opts: {
    hasProfile?: boolean;
    isPrivate?: boolean;
    isBlocked?: boolean;
    isSubscribed?: boolean;
  }) {
    const { hasProfile = true, isPrivate = false, isBlocked = false, isSubscribed = false } = opts;

    return {
      selectFrom: (table: string) => {
        if (table === 'auth.public_profiles') {
          return {
            select: () => ({
              where: () => ({
                executeTakeFirst: async () =>
                  hasProfile ? { id: AUTHOR_ID, is_private: isPrivate } : undefined,
                execute: async () =>
                  hasProfile
                    ? [
                        { id: AUTHOR_ID, is_private: isPrivate },
                        { id: VIEWER_ID, is_private: false },
                      ]
                    : [],
              }),
            }),
          };
        }
        if (table === 'social.blocks') {
          return {
            select: () => ({
              where: () => ({
                executeTakeFirst: async () => (isBlocked ? { blocked: 1 } : undefined),
                execute: async () =>
                  isBlocked ? [{ blocker_id: VIEWER_ID, blocked_id: AUTHOR_ID }] : [],
              }),
            }),
          };
        }
        if (table === 'social.subscriptions') {
          return {
            select: () => ({
              where: () => ({
                where: () => ({
                  executeTakeFirst: async () => (isSubscribed ? { sub: 1 } : undefined),
                  execute: async () => (isSubscribed ? [{ channel_id: AUTHOR_ID }] : []),
                }),
                execute: async () => (isSubscribed ? [{ channel_id: AUTHOR_ID }] : []),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as unknown as Kysely<Database>;
  }

  describe('Author viewing own post', () => {
    it('author sees own PUBLIC post on public account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: false });
      const visible = await canSeePost(
        db,
        { userId: AUTHOR_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(true);
    });

    it('author sees own FOLLOWERS post on private account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: true });
      const visible = await canSeePost(
        db,
        { userId: AUTHOR_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'FOLLOWERS', status: 'VISIBLE' },
      );
      expect(visible).toBe(true);
    });

    it('author cannot see DELETED post', async () => {
      const db = createMockDb({ hasProfile: true });
      const visible = await canSeePost(
        db,
        { userId: AUTHOR_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'DELETED' },
      );
      expect(visible).toBe(false);
    });

    it('author cannot see HIDDEN post unless moderator', async () => {
      const db = createMockDb({ hasProfile: true });
      const userVisible = await canSeePost(
        db,
        { userId: AUTHOR_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'HIDDEN' },
      );
      expect(userVisible).toBe(false);

      const modVisible = await canSeePost(
        db,
        { userId: AUTHOR_ID, isModeratorOrAdmin: true },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'HIDDEN' },
      );
      expect(modVisible).toBe(true);
    });
  });

  describe('Public account tests', () => {
    it('non-follower can see PUBLIC post on public account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: false, isSubscribed: false });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(true);
    });

    it('anonymous viewer can see PUBLIC post on public account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: false });
      const visible = await canSeePost(
        db,
        { userId: null, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(true);
    });

    it('non-follower CANNOT see FOLLOWERS post on public account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: false, isSubscribed: false });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'FOLLOWERS', status: 'VISIBLE' },
      );
      expect(visible).toBe(false);
    });

    it('follower CAN see FOLLOWERS post on public account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: false, isSubscribed: true });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'FOLLOWERS', status: 'VISIBLE' },
      );
      expect(visible).toBe(true);
    });

    it('blocked user CANNOT see PUBLIC post', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: false, isBlocked: true });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(false);
    });
  });

  describe('Private account tests', () => {
    it('non-follower CANNOT see PUBLIC post on private account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: true, isSubscribed: false });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(false);
    });

    it('anonymous viewer CANNOT see PUBLIC post on private account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: true });
      const visible = await canSeePost(
        db,
        { userId: null, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(false);
    });

    it('follower CAN see PUBLIC post on private account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: true, isSubscribed: true });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(true);
    });

    it('follower CAN see FOLLOWERS post on private account', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: true, isSubscribed: true });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'FOLLOWERS', status: 'VISIBLE' },
      );
      expect(visible).toBe(true);
    });

    it('follower who is blocked CANNOT see post on private account', async () => {
      const db = createMockDb({
        hasProfile: true,
        isPrivate: true,
        isSubscribed: true,
        isBlocked: true,
      });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(false);
    });
  });

  describe('Missing profile tests', () => {
    it('returns false if author profile does not exist', async () => {
      const db = createMockDb({ hasProfile: false });
      const visible = await canSeePost(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        { id: POST_ID, author_id: AUTHOR_ID, visibility: 'PUBLIC', status: 'VISIBLE' },
      );
      expect(visible).toBe(false);
    });
  });

  describe('batchCheckCanSeePosts batch evaluation', () => {
    it('returns empty map for empty post list', async () => {
      const db = createMockDb({});
      const map = await batchCheckCanSeePosts(db, { userId: VIEWER_ID }, []);
      expect(map.size).toBe(0);
    });

    it('batches visibility checks across multiple posts with mixed states', async () => {
      const db = createMockDb({ hasProfile: true, isPrivate: false, isSubscribed: true });
      const posts = [
        {
          id: 'p1',
          author_id: AUTHOR_ID,
          visibility: 'PUBLIC' as const,
          status: 'VISIBLE' as const,
        },
        {
          id: 'p2',
          author_id: AUTHOR_ID,
          visibility: 'FOLLOWERS' as const,
          status: 'VISIBLE' as const,
        },
        {
          id: 'p3',
          author_id: AUTHOR_ID,
          visibility: 'PUBLIC' as const,
          status: 'DELETED' as const,
        },
        {
          id: 'p4',
          author_id: AUTHOR_ID,
          visibility: 'PUBLIC' as const,
          status: 'HIDDEN' as const,
        },
        {
          id: 'p5',
          author_id: VIEWER_ID,
          visibility: 'PUBLIC' as const,
          status: 'VISIBLE' as const,
        },
      ];

      const resUser = await batchCheckCanSeePosts(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: false },
        posts,
      );
      expect(resUser.get('p1')).toBe(true);
      expect(resUser.get('p2')).toBe(true);
      expect(resUser.get('p3')).toBe(false);
      expect(resUser.get('p4')).toBe(false);
      expect(resUser.get('p5')).toBe(true);

      const resMod = await batchCheckCanSeePosts(
        db,
        { userId: VIEWER_ID, isModeratorOrAdmin: true },
        posts,
      );
      expect(resMod.get('p4')).toBe(true); // mod sees HIDDEN
    });
  });
});
