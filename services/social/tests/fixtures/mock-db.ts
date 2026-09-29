import { Kysely, PostgresDialect } from 'kysely';
import type { Database, CommentStatus } from '../../src/db/types.js';

export interface MockStore {
  videos: Array<{
    id: string;
    owner_id: string;
    like_count: number;
    comment_count: number;
    created_at: Date;
  }>;
  comments: Array<{
    id: string;
    video_id: string;
    author_id: string;
    parent_id: string | null;
    body: string;
    status: CommentStatus;
    reply_count: number;
    created_at: Date;
    edited_at: Date | null;
    updated_at: Date;
  }>;
  video_likes: Array<{
    video_id: string;
    user_id: string;
    created_at: Date;
  }>;
  channels: Array<{
    id: string;
    subscriber_count: number;
  }>;
  subscriptions: Array<{
    subscriber_id: string;
    channel_id: string;
    created_at: Date;
  }>;
  outbox: Array<{
    id: string;
    event_id: string;
    subject: string;
    payload: unknown;
    created_at: Date;
    published_at: Date | null;
  }>;
  public_profiles: Array<{
    id: string;
    handle: string;
    display_name: string;
    avatar_key: string | null;
  }>;
}

export function createMockStore(): MockStore {
  return {
    videos: [],
    comments: [],
    video_likes: [],
    channels: [],
    subscriptions: [],
    outbox: [],
    public_profiles: [],
  };
}

export function createMockDb(store: MockStore = createMockStore()): {
  db: Kysely<Database>;
  store: MockStore;
} {
  let idCounter = 1;

  const mockClient = {
    async query(sqlText: string, params: unknown[] = []) {
      const sql = sqlText.trim();

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      // SELECT 1 (health check)
      if (/^select\s+1$/i.test(sql)) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }

      // 1. VIDEOS
      if (
        sql.includes('insert into "social"."videos"') ||
        sql.includes('insert into social.videos')
      ) {
        const [id, owner_id] = params as [string, string];
        const existing = store.videos.find((v) => v.id === id);
        if (!existing) {
          const newVideo = {
            id,
            owner_id,
            like_count: 0,
            comment_count: 0,
            created_at: new Date(),
          };
          store.videos.push(newVideo);
          return { rows: [newVideo], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (
        sql.includes('delete from "social"."videos"') ||
        sql.includes('delete from social.videos')
      ) {
        const [videoId] = params as [string];
        const initialLen = store.videos.length;
        store.videos = store.videos.filter((v) => v.id !== videoId);
        // Cascade delete comments and likes
        store.comments = store.comments.filter((c) => c.video_id !== videoId);
        store.video_likes = store.video_likes.filter((vl) => vl.video_id !== videoId);
        return { rows: [], rowCount: initialLen - store.videos.length };
      }

      // 2. COMMENTS
      if (
        sql.includes('insert into "social"."comments"') ||
        sql.includes('insert into social.comments')
      ) {
        const [id, video_id, author_id, parent_id, body, status] = params as [
          string,
          string,
          string,
          string | null,
          string,
          CommentStatus,
        ];

        // Check parent two levels
        if (parent_id) {
          const parent = store.comments.find((c) => c.id === parent_id);
          if (!parent || parent.parent_id !== null || parent.video_id !== video_id) {
            const err = new Error('check_violation: guard_comment_parent') as Error & {
              code?: string;
            };
            err.code = '23514';
            throw err;
          }
          if (status === 'VISIBLE') {
            parent.reply_count += 1;
          }
        }

        const video = store.videos.find((v) => v.id === video_id);
        if (video && status === 'VISIBLE') {
          video.comment_count += 1;
        }

        const newComment = {
          id,
          video_id,
          author_id,
          parent_id: parent_id || null,
          body,
          status: status || 'VISIBLE',
          reply_count: 0,
          created_at: new Date(),
          edited_at: null,
          updated_at: new Date(),
        };
        store.comments.push(newComment);
        return { rows: [newComment], rowCount: 1 };
      }

      // UPDATE COMMENTS
      if (sql.includes('update "social"."comments"') || sql.includes('update social.comments')) {
        const comment = store.comments.find((c) => params.includes(c.id));
        if (!comment) return { rows: [], rowCount: 0 };

        if (sql.includes('"status" = $1') && sql.includes('"body" = $2')) {
          // Soft delete
          const [newStatus, newBody] = params as [CommentStatus, string];
          const oldStatus = comment.status;
          comment.status = newStatus;
          comment.body = newBody;
          comment.updated_at = new Date();

          if (oldStatus === 'VISIBLE' && newStatus !== 'VISIBLE') {
            const video = store.videos.find((v) => v.id === comment.video_id);
            if (video && video.comment_count > 0) video.comment_count -= 1;
            if (comment.parent_id) {
              const parent = store.comments.find((c) => c.id === comment.parent_id);
              if (parent && parent.reply_count > 0) parent.reply_count -= 1;
            }
          }
          return { rows: [comment], rowCount: 1 };
        }

        if (sql.includes('"status" = $1')) {
          // Moderation
          const [newStatus] = params as [CommentStatus];
          const oldStatus = comment.status;
          comment.status = newStatus;
          comment.updated_at = new Date();

          const video = store.videos.find((v) => v.id === comment.video_id);
          const parent = comment.parent_id
            ? store.comments.find((c) => c.id === comment.parent_id)
            : null;

          if (oldStatus === 'VISIBLE' && newStatus !== 'VISIBLE') {
            if (video && video.comment_count > 0) video.comment_count -= 1;
            if (parent && parent.reply_count > 0) parent.reply_count -= 1;
          } else if (oldStatus !== 'VISIBLE' && newStatus === 'VISIBLE') {
            if (video) video.comment_count += 1;
            if (parent) parent.reply_count += 1;
          }
          return { rows: [comment], rowCount: 1 };
        }

        if (sql.includes('"body" = $1')) {
          // Edit body
          const [newBody] = params as [string];
          comment.body = newBody;
          comment.edited_at = new Date();
          comment.updated_at = new Date();
          return { rows: [comment], rowCount: 1 };
        }
      }

      // 3. VIDEO LIKES
      if (
        sql.includes('INSERT INTO social.video_likes') ||
        sql.includes('insert into social.video_likes')
      ) {
        const [videoId, userId] = params as [string, string];
        const existing = store.video_likes.find(
          (vl) => vl.video_id === videoId && vl.user_id === userId,
        );
        if (existing) {
          return { rows: [], rowCount: 0 };
        }
        store.video_likes.push({ video_id: videoId, user_id: userId, created_at: new Date() });
        const video = store.videos.find((v) => v.id === videoId);
        if (video) video.like_count += 1;
        return { rows: [{ inserted: 1 }], rowCount: 1 };
      }

      if (
        sql.includes('DELETE FROM social.video_likes') ||
        sql.includes('delete from social.video_likes')
      ) {
        const [videoId, userId] = params as [string, string];
        const idx = store.video_likes.findIndex(
          (vl) => vl.video_id === videoId && vl.user_id === userId,
        );
        if (idx !== -1) {
          store.video_likes.splice(idx, 1);
          const video = store.videos.find((v) => v.id === videoId);
          if (video && video.like_count > 0) video.like_count -= 1;
          return { rows: [{ deleted: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 4. SUBSCRIPTIONS
      if (
        sql.includes('INSERT INTO social.subscriptions') ||
        sql.includes('insert into social.subscriptions')
      ) {
        const [subscriberId, channelId] = params as [string, string];
        const existing = store.subscriptions.find(
          (s) => s.subscriber_id === subscriberId && s.channel_id === channelId,
        );
        if (existing) {
          return { rows: [], rowCount: 0 };
        }
        store.subscriptions.push({
          subscriber_id: subscriberId,
          channel_id: channelId,
          created_at: new Date(),
        });
        let channel = store.channels.find((c) => c.id === channelId);
        if (!channel) {
          channel = { id: channelId, subscriber_count: 1 };
          store.channels.push(channel);
        } else {
          channel.subscriber_count += 1;
        }
        return { rows: [{ inserted: 1 }], rowCount: 1 };
      }

      if (
        sql.includes('DELETE FROM social.subscriptions') ||
        sql.includes('delete from social.subscriptions')
      ) {
        const [subscriberId, channelId] = params as [string, string];
        const idx = store.subscriptions.findIndex(
          (s) => s.subscriber_id === subscriberId && s.channel_id === channelId,
        );
        if (idx !== -1) {
          store.subscriptions.splice(idx, 1);
          const channel = store.channels.find((c) => c.id === channelId);
          if (channel && channel.subscriber_count > 0) channel.subscriber_count -= 1;
          return { rows: [{ deleted: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 5. OUTBOX
      if (
        sql.includes('INSERT INTO "social"."outbox"') ||
        sql.includes('insert into "social"."outbox"') ||
        sql.includes('social.outbox')
      ) {
        const [eventId, subject, payload] = params as [string, string, unknown];
        const newOutbox = {
          id: String(idCounter++),
          event_id: eventId,
          subject,
          payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
          created_at: new Date(),
          published_at: null,
        };
        store.outbox.push(newOutbox);
        return { rows: [newOutbox], rowCount: 1 };
      }

      // 6. SELECT QUERIES
      // Select single video
      if (sql.includes('from "social"."videos"') || sql.includes('from social.videos')) {
        const videoId = String(params[0]);
        const video = store.videos.find((v) => v.id === videoId);
        return { rows: video ? [video] : [], rowCount: video ? 1 : 0 };
      }

      // Select channel
      if (sql.includes('from "social"."channels"') || sql.includes('from social.channels')) {
        const channelId = String(params[0]);
        const channel = store.channels.find((c) => c.id === channelId);
        return { rows: channel ? [channel] : [], rowCount: channel ? 1 : 0 };
      }

      // Select public profiles
      if (
        sql.includes('from "auth"."public_profiles"') ||
        sql.includes('from auth.public_profiles')
      ) {
        const profileId = String(params[0]);
        const profile = store.public_profiles.find((p) => p.id === profileId);
        return { rows: profile ? [profile] : [], rowCount: profile ? 1 : 0 };
      }

      // Check single like
      if (sql.includes('from "social"."video_likes"') || sql.includes('from social.video_likes')) {
        const [videoId, userId] = params as [string, string];
        const exists = store.video_likes.some(
          (vl) => vl.video_id === videoId && vl.user_id === userId,
        );
        return { rows: exists ? [{ one: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // Check subscription
      if (sql.includes('from "social"."subscriptions"') && !sql.includes('join')) {
        const [subscriberId, channelId] = params as [string, string];
        const exists = store.subscriptions.some(
          (s) => s.subscriber_id === subscriberId && s.channel_id === channelId,
        );
        return { rows: exists ? [{ one: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // List my subscriptions (joined with public_profiles)
      if (
        sql.includes('from "social"."subscriptions"') &&
        sql.includes('"auth"."public_profiles"')
      ) {
        const subscriberId = String(params[0]);
        const matchedSubs = store.subscriptions.filter((s) => s.subscriber_id === subscriberId);
        const joined = matchedSubs
          .map((s) => {
            const p = store.public_profiles.find((prof) => prof.id === s.channel_id);
            if (!p) return null;
            return {
              channel_id: s.channel_id,
              subscribed_at: s.created_at,
              subscribed_at_cursor: s.created_at.toISOString(),
              profile_id: p.id,
              profile_handle: p.handle,
              profile_display_name: p.display_name,
              profile_avatar_key: p.avatar_key,
            };
          })
          .filter(Boolean)
          .sort((a, b) => b!.subscribed_at.getTime() - a!.subscribed_at.getTime());

        return { rows: joined, rowCount: joined.length };
      }

      // Select single comment (deep link / join)
      if (sql.includes('where "c"."id" = $1') || sql.includes('where "id" = $1')) {
        const commentId = String(params[0]);
        const comment = store.comments.find((c) => c.id === commentId);
        if (!comment) return { rows: [], rowCount: 0 };

        const video = store.videos.find((v) => v.id === comment.video_id);
        const profile = store.public_profiles.find((p) => p.id === comment.author_id);

        const row = {
          ...comment,
          created_at_cursor: comment.created_at.toISOString(),
          video_owner_id: video?.owner_id,
          profile_id: profile?.id,
          profile_handle: profile?.handle,
          profile_display_name: profile?.display_name,
          profile_avatar_key: profile?.avatar_key,
        };
        return { rows: [row], rowCount: 1 };
      }

      // Check replies for DELETED check
      if (sql.includes('where "parent_id" = $1') && sql.includes('limit 1')) {
        const parentId = String(params[0]);
        const hasReplies = store.comments.some((c) => c.parent_id === parentId);
        return { rows: hasReplies ? [{ one: 1 }] : [], rowCount: hasReplies ? 1 : 0 };
      }

      // List comments (top-level or replies)
      if (sql.includes('from "social"."comments" as "c"')) {
        const isReplies = sql.includes('where "c"."parent_id" = $1');
        const idParam = String(params[0]);

        let matched = isReplies
          ? store.comments.filter((c) => c.parent_id === idParam)
          : store.comments.filter((c) => c.video_id === idParam && c.parent_id === null);

        // Filter out HIDDEN unless moderator
        if (sql.includes('"c"."status" != $2') || sql.includes('"c"."status" != \'HIDDEN\'')) {
          matched = matched.filter((c) => c.status !== 'HIDDEN');
        }

        // Tombstone filter: DELETED top-level comments must have replies
        matched = matched.filter((c) => {
          if (c.status !== 'DELETED') return true;
          return store.comments.some((r) => r.parent_id === c.id);
        });

        // Sorting
        if (isReplies) {
          // Oldest first
          matched.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        } else {
          // Newest first
          matched.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        }

        const mapped = matched.map((c) => {
          const profile = store.public_profiles.find((p) => p.id === c.author_id);
          return {
            ...c,
            created_at_cursor: c.created_at.toISOString(),
            profile_id: profile?.id,
            profile_handle: profile?.handle,
            profile_display_name: profile?.display_name,
            profile_avatar_key: profile?.avatar_key,
          };
        });

        return { rows: mapped, rowCount: mapped.length };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  const mockPool = {
    connect: async () => mockClient,
    query: mockClient.query,
    end: async () => {},
  };

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: mockPool as any,
    }),
  });

  return { db, store };
}
