import { Kysely, PostgresDialect } from 'kysely';
import type {
  Database,
  CommentStatus,
  VideoVisibility,
  NotificationKind,
  PlaylistKind,
  PlaylistVisibility,
} from '../../src/db/types.js';

export interface MockStore {
  videos: Array<{
    id: string;
    owner_id: string;
    like_count: number;
    comment_count: number;
    hidden?: boolean;
    visibility?: VideoVisibility;
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
    created_at_micros?: string;
  }>;
  follow_requests: Array<{
    requester_id: string;
    target_id: string;
    created_at: Date;
    created_at_micros?: string;
  }>;
  blocks: Array<{
    blocker_id: string;
    blocked_id: string;
    created_at: Date;
    created_at_micros?: string;
  }>;
  mutes: Array<{
    muter_id: string;
    muted_id: string;
    created_at: Date;
    created_at_micros?: string;
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
    is_private?: boolean;
    bio?: string | null;
    links?: unknown;
    banner_key?: string | null;
  }>;
  reports: Array<{
    id: string;
    reporter_id: string;
    target_type: 'VIDEO' | 'COMMENT' | 'USER';
    target_id: string;
    reason: string;
    note: string;
    status: 'OPEN' | 'ACTIONED' | 'DISMISSED';
    resolved_by: string | null;
    resolution_note: string | null;
    resolved_at: Date | null;
    created_at: Date;
  }>;
  notifications: Array<{
    id: string;
    user_id: string;
    actor_id: string;
    kind: NotificationKind;
    video_id: string | null;
    comment_id: string | null;
    read_at: Date | null;
    created_at: Date;
    created_at_micros?: string;
  }>;
  playlists: Array<{
    id: string;
    owner_id: string;
    kind: PlaylistKind;
    title: string;
    description: string;
    visibility: PlaylistVisibility;
    item_count: number;
    is_series?: boolean;
    created_at: Date;
    updated_at: Date;
    updated_at_micros?: string;
  }>;
  playlist_items: Array<{
    playlist_id: string;
    video_id: string;
    position: number;
    added_at: Date;
  }>;
  posts: Array<{
    id: string;
    author_id: string;
    body: string;
    visibility: 'PUBLIC' | 'FOLLOWERS';
    status: 'VISIBLE' | 'DELETED' | 'HIDDEN';
    media_count: number;
    video_id: string | null;
    reshare_of: string | null;
    reaction_count: number;
    comment_count: number;
    reshare_count: number;
    created_at: Date;
    edited_at: Date | null;
    updated_at: Date;
  }>;
  post_media: Array<{
    post_id: string;
    position: number;
    image_id: string;
    image_key: string;
    thumb_key: string;
    width: number;
    height: number;
  }>;
  post_reactions: Array<{
    post_id: string;
    user_id: string;
    reaction: 'LIKE' | 'LOVE' | 'HAHA' | 'WOW' | 'SAD' | 'ANGRY';
    created_at: Date;
  }>;
  post_comments: Array<{
    id: string;
    post_id: string;
    author_id: string;
    parent_id: string | null;
    body: string;
    status: 'VISIBLE' | 'DELETED' | 'HIDDEN';
    reply_count: number;
    created_at: Date;
    edited_at: Date | null;
    updated_at: Date;
  }>;
  post_hashtags: Array<{
    post_id: string;
    tag: string;
    slug: string;
    created_at: Date;
  }>;
  post_mentions: Array<{
    post_id: string;
    user_id: string;
  }>;
  post_scores: Array<{
    post_id: string;
    score: number;
    computed_at: Date;
  }>;
  advisory_locks: Set<number>;
}

export function createMockStore(): MockStore {
  return {
    videos: [],
    comments: [],
    video_likes: [],
    channels: [],
    subscriptions: [],
    follow_requests: [],
    blocks: [],
    mutes: [],
    outbox: [],
    public_profiles: [],
    reports: [],
    notifications: [],
    playlists: [],
    playlist_items: [],
    posts: [],
    post_media: [],
    post_reactions: [],
    post_comments: [],
    post_hashtags: [],
    post_mentions: [],
    post_scores: [],
    advisory_locks: new Set<number>(),
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

      if (/pg_advisory_xact_lock/i.test(sql) || /set constraints/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // SELECT 1 (health check)
      if (/^select\s+1$/i.test(sql)) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }

      // Advisory locks
      if (/pg_try_advisory_lock/i.test(sql)) {
        const key = Number(params[0]);
        if (store.advisory_locks.has(key)) {
          return { rows: [{ locked: false }], rowCount: 1 };
        }
        store.advisory_locks.add(key);
        return { rows: [{ locked: true }], rowCount: 1 };
      }

      if (/pg_advisory_unlock/i.test(sql)) {
        const key = Number(params[0]);
        store.advisory_locks.delete(key);
        return { rows: [{ unlocked: true }], rowCount: 1 };
      }

      // 1. VIDEOS
      if (
        sql.includes('insert into "social"."videos"') ||
        sql.includes('insert into social.videos')
      ) {
        const id = String(params[0]);
        const owner_id = String(params[1]);
        let visibility: VideoVisibility = 'PUBLIC';
        if (sql.includes('"visibility"') && params.length >= 3) {
          visibility = params[2] as VideoVisibility;
        }
        const existing = store.videos.find((v) => v.id === id);
        if (!existing) {
          const newVideo = {
            id,
            owner_id,
            like_count: 0,
            comment_count: 0,
            hidden: false,
            visibility,
            created_at: new Date(),
          };
          store.videos.push(newVideo);
          return { rows: [newVideo], rowCount: 1 };
        }
        existing.owner_id = owner_id;
        if (sql.includes('"visibility"') || sql.includes('visibility')) {
          existing.visibility = visibility;
        }
        return { rows: [existing], rowCount: 1 };
      }

      if (sql.includes('update "social"."videos"') || sql.includes('update social.videos')) {
        const videoId = String(params[params.length - 1]);
        const video = store.videos.find((v) => v.id === videoId);
        if (video) {
          if (sql.includes('"hidden"') || sql.includes('hidden')) {
            video.hidden = Boolean(params[0]);
          }
          if (sql.includes('"visibility"') || sql.includes('visibility')) {
            video.visibility = params[0] as VideoVisibility;
          }
          return { rows: [video], rowCount: 1 };
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
        sql.includes('delete from social.subscriptions') ||
        sql.includes('DELETE FROM "social"."subscriptions"') ||
        sql.includes('delete from "social"."subscriptions"')
      ) {
        if (sql.includes('RETURNING') && (sql.includes('OR') || params.length >= 4)) {
          const userA = String(params[0]);
          const userB = String(params[1]);
          const deleted: Array<{ subscriber_id: string; channel_id: string }> = [];
          store.subscriptions = store.subscriptions.filter((s) => {
            const matches =
              (s.subscriber_id === userA && s.channel_id === userB) ||
              (s.subscriber_id === userB && s.channel_id === userA);
            if (matches) {
              deleted.push({ subscriber_id: s.subscriber_id, channel_id: s.channel_id });
              const ch = store.channels.find((c) => c.id === s.channel_id);
              if (ch && ch.subscriber_count > 0) ch.subscriber_count -= 1;
              return false;
            }
            return true;
          });
          return { rows: deleted, rowCount: deleted.length };
        }
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

      // 4b. FOLLOW REQUESTS
      if (
        sql.includes('insert into "social"."follow_requests"') ||
        sql.includes('insert into social.follow_requests') ||
        sql.includes('INSERT INTO social.follow_requests')
      ) {
        const [requesterId, targetId] = params as [string, string];
        const existing = store.follow_requests.find(
          (fr) => fr.requester_id === requesterId && fr.target_id === targetId,
        );
        if (!existing) {
          store.follow_requests.push({
            requester_id: requesterId,
            target_id: targetId,
            created_at: new Date(),
          });
          return { rows: [{ requester_id: requesterId, target_id: targetId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (
        sql.includes('delete from "social"."follow_requests"') ||
        sql.includes('delete from social.follow_requests') ||
        sql.includes('DELETE FROM social.follow_requests')
      ) {
        if (sql.includes('OR') || params.length >= 4) {
          const userA = String(params[0]);
          const userB = String(params[1]);
          const initialLen = store.follow_requests.length;
          store.follow_requests = store.follow_requests.filter(
            (fr) =>
              !(
                (fr.requester_id === userA && fr.target_id === userB) ||
                (fr.requester_id === userB && fr.target_id === userA)
              ),
          );
          return { rows: [], rowCount: initialLen - store.follow_requests.length };
        }
        const [requesterId, targetId] = params as [string, string];
        const idx = store.follow_requests.findIndex(
          (fr) => fr.requester_id === requesterId && fr.target_id === targetId,
        );
        if (idx !== -1) {
          const removed = store.follow_requests.splice(idx, 1)[0];
          return { rows: [removed], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 4c. BLOCKS
      if (
        sql.includes('insert into "social"."blocks"') ||
        sql.includes('insert into social.blocks') ||
        sql.includes('INSERT INTO social.blocks')
      ) {
        const [blockerId, blockedId] = params as [string, string];
        const existing = store.blocks.find(
          (b) => b.blocker_id === blockerId && b.blocked_id === blockedId,
        );
        if (!existing) {
          store.blocks.push({
            blocker_id: blockerId,
            blocked_id: blockedId,
            created_at: new Date(),
          });
          return { rows: [{ blocker_id: blockerId, blocked_id: blockedId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (
        sql.includes('delete from "social"."blocks"') ||
        sql.includes('delete from social.blocks') ||
        sql.includes('DELETE FROM social.blocks')
      ) {
        const [blockerId, blockedId] = params as [string, string];
        const idx = store.blocks.findIndex(
          (b) => b.blocker_id === blockerId && b.blocked_id === blockedId,
        );
        if (idx !== -1) {
          store.blocks.splice(idx, 1);
          return { rows: [{ deleted: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 4d. MUTES
      if (
        sql.includes('insert into "social"."mutes"') ||
        sql.includes('insert into social.mutes') ||
        sql.includes('INSERT INTO social.mutes')
      ) {
        const [muterId, mutedId] = params as [string, string];
        const existing = store.mutes.find((m) => m.muter_id === muterId && m.muted_id === mutedId);
        if (!existing) {
          store.mutes.push({
            muter_id: muterId,
            muted_id: mutedId,
            created_at: new Date(),
          });
          return { rows: [{ muter_id: muterId, muted_id: mutedId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (
        sql.includes('delete from "social"."mutes"') ||
        sql.includes('delete from social.mutes') ||
        sql.includes('DELETE FROM social.mutes')
      ) {
        const [muterId, mutedId] = params as [string, string];
        const idx = store.mutes.findIndex((m) => m.muter_id === muterId && m.muted_id === mutedId);
        if (idx !== -1) {
          store.mutes.splice(idx, 1);
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

      // 5b. REPORTS INSERT AND UPDATE
      if (
        sql.includes('insert into "social"."reports"') ||
        sql.includes('insert into social.reports')
      ) {
        const [id, reporter_id, target_type, target_id, reason, note] = params as [
          string,
          string,
          'VIDEO' | 'COMMENT' | 'USER',
          string,
          string,
          string,
        ];
        const existingOpen = store.reports.find(
          (r) =>
            r.reporter_id === reporter_id &&
            r.target_type === target_type &&
            r.target_id === target_id &&
            r.status === 'OPEN',
        );
        if (existingOpen) {
          return { rows: [], rowCount: 0 };
        }
        const now = new Date();
        const newReport = {
          id,
          reporter_id,
          target_type,
          target_id,
          reason,
          note: note || '',
          status: 'OPEN' as const,
          resolved_by: null,
          resolution_note: null,
          resolved_at: null,
          created_at: now,
        };
        store.reports.push(newReport);
        return {
          rows: [{ id: newReport.id, created_at_iso: now.toISOString() }],
          rowCount: 1,
        };
      }

      if (sql.includes('update "social"."reports"') || sql.includes('update social.reports')) {
        const [
          status,
          resolved_by,
          resolution_note,
          resolved_at,
          target_type,
          target_id,
          whereStatus,
        ] = params as [
          'ACTIONED' | 'DISMISSED',
          string,
          string | null,
          Date,
          string,
          string,
          string,
        ];

        let count = 0;
        for (const r of store.reports) {
          if (
            r.target_type === target_type &&
            r.target_id === target_id &&
            r.status === whereStatus
          ) {
            r.status = status;
            r.resolved_by = resolved_by;
            r.resolution_note = resolution_note;
            r.resolved_at = resolved_at;
            count++;
          }
        }
        return { rows: [], rowCount: count, command: 'UPDATE' };
      }

      // 5c. NOTIFICATIONS
      if (
        (sql.includes('insert into "social"."notifications"') ||
          sql.includes('insert into social.notifications') ||
          sql.includes('INSERT INTO social.notifications')) &&
        sql.includes('unnest')
      ) {
        // Fanout insert: SELECT u.id, u.subscriber_id, $1::uuid, 'VIDEO_PUBLISHED', $2::uuid, NULL, $3 FROM unnest($4::uuid[], $5::uuid[])
        const actorId = String(params[0]);
        const videoId = String(params[1]);
        const createdAt = params[2] instanceof Date ? params[2] : new Date(String(params[2]));
        const ids = (params[3] as string[]) || [];
        const userIds = (params[4] as string[]) || [];

        const newlyInserted: { id: string }[] = [];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const userId = userIds[i];
          if (userId === actorId) continue;
          const dedupKey = `${userId}::VIDEO_PUBLISHED::${videoId}`;
          const existing = store.notifications.some(
            (n) =>
              `${n.user_id}::${n.kind}::${n.comment_id || n.video_id || n.actor_id}` === dedupKey,
          );
          if (!existing) {
            store.notifications.push({
              id,
              user_id: userId,
              actor_id: actorId,
              kind: 'VIDEO_PUBLISHED',
              video_id: videoId,
              comment_id: null,
              read_at: null,
              created_at: createdAt,
            });
            newlyInserted.push({ id });
          }
        }
        return { rows: newlyInserted, rowCount: newlyInserted.length };
      }

      if (
        sql.includes('insert into "social"."notifications"') ||
        sql.includes('insert into social.notifications') ||
        sql.includes('INSERT INTO social.notifications')
      ) {
        const id = String(params[0]);
        const userId = String(params[1]);
        const kind = params[2] as NotificationKind;
        const actorId = String(params[3]);
        const videoId = params[4] ? String(params[4]) : null;
        const commentId = params[5] ? String(params[5]) : null;

        if (userId === actorId) {
          const err = new Error('check_violation: notifications_not_self') as Error & {
            code?: string;
          };
          err.code = '23514';
          throw err;
        }

        const dedupKey = `${userId}::${kind}::${commentId || videoId || actorId}`;
        const existing = store.notifications.some(
          (n) =>
            `${n.user_id}::${n.kind}::${n.comment_id || n.video_id || n.actor_id}` === dedupKey,
        );
        if (existing) {
          return { rows: [], rowCount: 0 };
        }

        const newNotif = {
          id,
          user_id: userId,
          actor_id: actorId,
          kind,
          video_id: videoId,
          comment_id: commentId,
          read_at: null,
          created_at: new Date(),
        };
        store.notifications.push(newNotif);
        return { rows: [newNotif], rowCount: 1 };
      }

      if (
        (sql.includes('delete from social.notifications') ||
          sql.includes('delete from "social"."notifications"') ||
          sql.includes('DELETE FROM social.notifications')) &&
        (sql.includes('created_at <') || sql.includes('created_at <='))
      ) {
        const retentionDays = Number(params[0] ?? 90);
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const toDelete = store.notifications
          .filter((n) => n.created_at < cutoff)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
          .slice(0, 5000);

        const deleteIds = new Set(toDelete.map((n) => n.id));
        store.notifications = store.notifications.filter((n) => !deleteIds.has(n.id));
        return { rows: [], rowCount: toDelete.length };
      }

      if (
        sql.includes('update social.notifications') ||
        sql.includes('update "social"."notifications"') ||
        sql.includes('UPDATE social.notifications')
      ) {
        const userId = String(params[0]);
        let count = 0;
        const now = new Date();

        if (sql.includes('ANY(') || sql.includes('id = ANY') || sql.includes('"id" in (')) {
          const ids = (params[1] as string[]) || [];
          const idSet = new Set(ids);
          for (const n of store.notifications) {
            if (n.user_id === userId && n.read_at === null && idSet.has(n.id)) {
              n.read_at = now;
              count++;
            }
          }
        } else if (sql.includes('created_at <') || sql.includes('created_at <=')) {
          const upToStr = String(params[1]);
          const upToDate = new Date(upToStr);
          const hasInterval1Ms = sql.includes("interval '1 millisecond'");
          const cutoffMs = hasInterval1Ms ? upToDate.getTime() + 1 : upToDate.getTime();

          for (const n of store.notifications) {
            if (n.user_id === userId && n.read_at === null) {
              const notifMs = n.created_at.getTime();
              if (hasInterval1Ms) {
                if (notifMs < cutoffMs) {
                  n.read_at = now;
                  count++;
                }
              } else {
                if (notifMs <= cutoffMs) {
                  n.read_at = now;
                  count++;
                }
              }
            }
          }
        }
        return { rows: [], rowCount: count, command: 'UPDATE' };
      }

      // 5d. PLAYLISTS & PLAYLIST ITEMS (Task PL1)
      if (
        sql.includes('insert into "social"."playlists"') ||
        sql.includes('insert into social.playlists') ||
        sql.includes('INSERT INTO social.playlists')
      ) {
        if (
          sql.includes('WATCH_LATER') &&
          (sql.includes('do nothing') || sql.includes('DO NOTHING'))
        ) {
          const id = String(params[0]);
          const ownerId = String(params[1]);
          const existing = store.playlists.find(
            (p) => p.owner_id === ownerId && p.kind === 'WATCH_LATER',
          );
          if (!existing) {
            const now = new Date();
            const newPl = {
              id,
              owner_id: ownerId,
              kind: 'WATCH_LATER' as PlaylistKind,
              title: 'Xem sau',
              description: '',
              visibility: 'PRIVATE' as PlaylistVisibility,
              item_count: 0,
              is_series: false,
              created_at: now,
              updated_at: now,
            };
            store.playlists.push(newPl);
            return { rows: [newPl], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }

        const id = String(params[0]);
        const ownerId = String(params[1]);
        const kind = (params[2] as PlaylistKind) || 'REGULAR';
        const title = String(params[3]);
        const description = String(params[4] ?? '');
        const visibility = (params[5] as PlaylistVisibility) || 'PRIVATE';
        const isSeries = sql.includes('is_series')
          ? Boolean(params.find((p) => typeof p === 'boolean'))
          : false;
        const itemCount = Number(params.find((p) => typeof p === 'number') ?? 0);
        const now = new Date();

        const newPl = {
          id,
          owner_id: ownerId,
          kind,
          title,
          description,
          visibility,
          is_series: isSeries,
          item_count: itemCount,
          created_at: now,
          updated_at: now,
        };
        store.playlists.push(newPl);
        return { rows: [newPl], rowCount: 1 };
      }

      if (
        sql.includes('update "social"."playlists"') ||
        sql.includes('update social.playlists') ||
        sql.includes('UPDATE social.playlists')
      ) {
        const playlistId = String(params[params.length - 1]);
        const pl = store.playlists.find((p) => p.id === playlistId);
        if (pl) {
          let paramIdx = 0;
          if (sql.includes('"updated_at" =') || sql.includes('updated_at =')) {
            const dateVal = params[paramIdx++];
            pl.updated_at = dateVal instanceof Date ? dateVal : new Date(String(dateVal));
          } else {
            pl.updated_at = new Date();
          }
          if (sql.includes('title =') || sql.includes('"title" =')) {
            pl.title = String(params[paramIdx++]);
          }
          if (sql.includes('description =') || sql.includes('"description" =')) {
            pl.description = String(params[paramIdx++]);
          }
          if (sql.includes('visibility =') || sql.includes('"visibility" =')) {
            pl.visibility = params[paramIdx++] as PlaylistVisibility;
          }
          if (sql.includes('is_series =') || sql.includes('"is_series" =')) {
            const isSeriesVal = params.find((p) => typeof p === 'boolean');
            if (isSeriesVal !== undefined) {
              if (isSeriesVal) {
                // Check foreign items to simulate trigger
                const hasForeign = store.playlist_items.some((pi) => {
                  if (pi.playlist_id !== pl.id) return false;
                  const v = store.videos.find((vid) => vid.id === pi.video_id);
                  return v && v.owner_id !== pl.owner_id;
                });
                if (hasForeign) {
                  const err = new Error('check_violation: SERIES_FOREIGN_ITEM') as Error & {
                    code?: string;
                  };
                  err.code = '23514';
                  throw err;
                }
              }
              pl.is_series = isSeriesVal;
            }
          }
          return { rows: [{ ...pl, is_series: pl.is_series ?? false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (
        sql.includes('delete from "social"."playlists"') ||
        sql.includes('delete from social.playlists') ||
        sql.includes('DELETE FROM social.playlists')
      ) {
        const playlistId = String(params[0]);
        store.playlists = store.playlists.filter((p) => p.id !== playlistId);
        store.playlist_items = store.playlist_items.filter((pi) => pi.playlist_id !== playlistId);
        return { rows: [], rowCount: 1 };
      }

      if (
        sql.includes('insert into "social"."playlist_items"') ||
        sql.includes('insert into social.playlist_items') ||
        sql.includes('INSERT INTO social.playlist_items')
      ) {
        const playlistId = String(params[0]);
        const videoId = String(params[1]);
        const position = Number(params[2]);
        const now = new Date();

        const pl = store.playlists.find((p) => p.id === playlistId);
        if (pl && pl.item_count >= 5000) {
          const err = new Error('check_violation: playlists_item_count') as Error & {
            code?: string;
          };
          err.code = '23514';
          throw err;
        }

        if (pl && pl.is_series) {
          const v = store.videos.find((vid) => vid.id === videoId);
          if (v && v.owner_id !== pl.owner_id) {
            const err = new Error('check_violation: SERIES_FOREIGN_ITEM') as Error & {
              code?: string;
            };
            err.code = '23514';
            throw err;
          }
        }

        const newItem = {
          playlist_id: playlistId,
          video_id: videoId,
          position,
          added_at: now,
        };
        store.playlist_items.push(newItem);
        if (pl) {
          pl.item_count++;
          pl.updated_at = now;
        }
        return { rows: [newItem], rowCount: 1 };
      }

      if (
        sql.includes('update "social"."playlist_items"') ||
        sql.includes('update social.playlist_items') ||
        sql.includes('UPDATE social.playlist_items')
      ) {
        const newPos = Number(params[0]);
        const playlistId = String(params[1]);
        const videoId = String(params[2]);
        const item = store.playlist_items.find(
          (i) => i.playlist_id === playlistId && i.video_id === videoId,
        );
        if (item) {
          item.position = newPos;
        }
        const pl = store.playlists.find((p) => p.id === playlistId);
        if (pl) {
          pl.updated_at = new Date();
        }
        return { rows: item ? [item] : [], rowCount: item ? 1 : 0 };
      }

      if (
        sql.includes('delete from "social"."playlist_items"') ||
        sql.includes('delete from social.playlist_items') ||
        sql.includes('DELETE FROM social.playlist_items')
      ) {
        const playlistId = String(params[0]);
        const videoId = String(params[1]);
        const beforeLen = store.playlist_items.length;
        store.playlist_items = store.playlist_items.filter(
          (i) => !(i.playlist_id === playlistId && i.video_id === videoId),
        );
        const deleted = beforeLen > store.playlist_items.length;
        if (deleted) {
          const pl = store.playlists.find((p) => p.id === playlistId);
          if (pl && pl.item_count > 0) {
            pl.item_count--;
            pl.updated_at = new Date();
          }
        }
        return { rows: [], rowCount: deleted ? 1 : 0 };
      }

      // Check foreign items for series (updatePlaylist)
      if (
        sql.includes('from "social"."playlist_items" as "pi"') &&
        sql.includes('join "social"."videos" as "v"') &&
        (sql.includes('"v"."owner_id" <>') || sql.includes('v.owner_id <>'))
      ) {
        const playlistId = String(params[0]);
        const ownerId = String(params[1]);
        const foreignItem = store.playlist_items.find((pi) => {
          if (pi.playlist_id !== playlistId) return false;
          const v = store.videos.find((vid) => vid.id === pi.video_id);
          return v && v.owner_id !== ownerId;
        });
        if (foreignItem) {
          return { rows: [{ owner_id: 'foreign' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 5e. CINEMA CATALOGUE & SERIES (Task CIN2 / ADR-035)
      // Cinema catalogue (kind=all, kind=series, kind=video)
      if (
        sql.includes('series_candidates') ||
        (sql.includes('social.playlists p') &&
          sql.includes('p.is_series = true') &&
          sql.includes('count(pi.video_id)::int AS episode_count')) ||
        (sql.includes('social.videos v') &&
          sql.includes('NOT EXISTS') &&
          sql.includes('p.is_series = true'))
      ) {
        const isSeriesOnly =
          sql.includes("'SERIES'::text AS kind") && !sql.includes('series_candidates');
        const isVideoOnly =
          sql.includes("'VIDEO'::text AS kind") && !sql.includes('series_candidates');

        // Series candidates
        const seriesRows: Array<{
          kind: 'SERIES' | 'VIDEO';
          id: string;
          sort_time: Date;
          sort_time_str: string;
          title: string | null;
          description: string | null;
          owner_id: string | null;
          episode_count: number | null;
          first_video_id: string | null;
          prof_id: string | null;
          prof_handle: string | null;
          prof_display_name: string | null;
          prof_avatar_key: string | null;
        }> = [];

        if (!isVideoOnly) {
          for (const p of store.playlists) {
            if (!p.is_series || p.visibility !== 'PUBLIC') continue;
            // Playable episodes
            const playable = store.playlist_items
              .filter((pi) => pi.playlist_id === p.id)
              .filter((pi) => {
                const v = store.videos.find((vid) => vid.id === pi.video_id);
                return v && v.visibility === 'PUBLIC' && !v.hidden && v.owner_id === p.owner_id;
              })
              .sort((a, b) => a.position - b.position || a.video_id.localeCompare(b.video_id));

            if (playable.length === 0) continue;

            const maxAddedAt = playable.reduce(
              (max, ep) => (ep.added_at > max ? ep.added_at : max),
              playable[0].added_at,
            );
            const prof = store.public_profiles.find((pr) => pr.id === p.owner_id);

            seriesRows.push({
              kind: 'SERIES',
              id: p.id,
              sort_time: maxAddedAt,
              sort_time_str: maxAddedAt.toISOString(),
              title: p.title,
              description: p.description,
              owner_id: p.owner_id,
              episode_count: playable.length,
              first_video_id: playable[0].video_id,
              prof_id: prof?.id ?? null,
              prof_handle: prof?.handle ?? null,
              prof_display_name: prof?.display_name ?? null,
              prof_avatar_key: prof?.avatar_key ?? null,
            });
          }
        }

        // Video candidates
        const videoRows: typeof seriesRows = [];
        if (!isSeriesOnly) {
          for (const v of store.videos) {
            if (v.visibility !== 'PUBLIC' || v.hidden) continue;
            // Check if it's an episode of any public series
            const inPublicSeries = store.playlists.some((p) => {
              if (!p.is_series || p.visibility !== 'PUBLIC' || p.owner_id !== v.owner_id)
                return false;
              return store.playlist_items.some(
                (pi) => pi.playlist_id === p.id && pi.video_id === v.id,
              );
            });
            if (inPublicSeries) continue;

            videoRows.push({
              kind: 'VIDEO',
              id: v.id,
              sort_time: v.created_at,
              sort_time_str: v.created_at.toISOString(),
              title: null,
              description: null,
              owner_id: null,
              episode_count: null,
              first_video_id: null,
              prof_id: null,
              prof_handle: null,
              prof_display_name: null,
              prof_avatar_key: null,
            });
          }
        }

        let combined = [...seriesRows, ...videoRows];
        // Sort timestamp desc, id desc
        combined.sort((a, b) => {
          const tDiff = b.sort_time.getTime() - a.sort_time.getTime();
          if (tDiff !== 0) return tDiff;
          return b.id.localeCompare(a.id);
        });

        // Filter cursor if present
        const cursorTimeParam = params.find(
          (p) => typeof p === 'string' && p.includes('T') && (p.includes('Z') || p.includes('+')),
        ) as string | undefined;
        const cursorIdParam = params.find(
          (p) =>
            typeof p === 'string' &&
            p.includes('-') &&
            p !== cursorTimeParam &&
            /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(p),
        ) as string | undefined;

        if (cursorTimeParam && cursorIdParam) {
          const cTime = new Date(cursorTimeParam).getTime();
          combined = combined.filter((r) => {
            const rTime = r.sort_time.getTime();
            if (rTime < cTime) return true;
            if (rTime === cTime && r.id < cursorIdParam) return true;
            return false;
          });
        }

        const limitParam = params.find((p) => typeof p === 'number' && p >= 1 && p <= 50);
        if (typeof limitParam === 'number') {
          combined = combined.slice(0, limitParam);
        }

        return { rows: combined, rowCount: combined.length };
      }

      // Series for video query (CIN3: GET /v1/series?video_id=)
      if (sql.includes('candidate_series') && sql.includes('series_metrics')) {
        const targetVideoId = String(params[0]);
        // 1. Find candidate series containing targetVideoId as a playable episode
        const candidateSeries: typeof store.playlists = [];
        for (const pi of store.playlist_items) {
          if (pi.video_id !== targetVideoId) continue;
          const pl = store.playlists.find((p) => p.id === pi.playlist_id);
          if (!pl || !pl.is_series || pl.visibility !== 'PUBLIC') continue;
          const v = store.videos.find((vid) => vid.id === targetVideoId);
          if (!v || v.visibility !== 'PUBLIC' || v.hidden || v.owner_id !== pl.owner_id) continue;
          if (!candidateSeries.some((p) => p.id === pl.id)) {
            candidateSeries.push(pl);
          }
        }

        // 2. Compute series_metrics for each candidate series
        const resultRows: Array<{
          id: string;
          title: string;
          description: string;
          owner_id: string;
          episode_count: number;
          first_video_id: string;
          updated_at: Date;
          prof_id: string | null;
          prof_handle: string | null;
          prof_display_name: string | null;
          prof_avatar_key: string | null;
        }> = [];

        for (const cs of candidateSeries) {
          const playable = store.playlist_items
            .filter((pi) => pi.playlist_id === cs.id)
            .filter((pi) => {
              const v = store.videos.find((vid) => vid.id === pi.video_id);
              return v && v.visibility === 'PUBLIC' && !v.hidden && v.owner_id === cs.owner_id;
            })
            .sort((a, b) => a.position - b.position || a.video_id.localeCompare(b.video_id));

          if (playable.length === 0) continue;

          const maxAddedAt = playable.reduce(
            (max, ep) => (ep.added_at > max ? ep.added_at : max),
            playable[0].added_at,
          );
          const firstVideoId = playable[0].video_id;

          const prof = store.public_profiles.find((p) => p.id === cs.owner_id);

          resultRows.push({
            id: cs.id,
            title: cs.title,
            description: cs.description,
            owner_id: cs.owner_id,
            episode_count: playable.length,
            first_video_id: firstVideoId,
            updated_at: maxAddedAt,
            prof_id: prof ? prof.id : null,
            prof_handle: prof ? prof.handle : null,
            prof_display_name: prof ? prof.display_name : null,
            prof_avatar_key: prof ? prof.avatar_key : null,
          });
        }

        resultRows.sort((a, b) => {
          const diff = b.updated_at.getTime() - a.updated_at.getTime();
          if (diff !== 0) return diff;
          return a.id.localeCompare(b.id);
        });

        const limited = resultRows.slice(0, 5);
        return { rows: limited, rowCount: limited.length };
      }

      // Playable episodes query for listSeriesEpisodes / getSeriesEpisode
      if (
        sql.includes('SELECT') &&
        sql.includes('pi.position') &&
        sql.includes('FROM social.playlist_items pi') &&
        sql.includes('JOIN social.videos v ON v.id = pi.video_id')
      ) {
        const playlistId = String(params[0]);
        const ownerId = String(params[1]);
        const pl = store.playlists.find((p) => p.id === playlistId);

        const playable = store.playlist_items
          .filter((pi) => pi.playlist_id === playlistId)
          .filter((pi) => {
            const v = store.videos.find((vid) => vid.id === pi.video_id);
            return (
              v &&
              v.visibility === 'PUBLIC' &&
              !v.hidden &&
              v.owner_id === (pl ? pl.owner_id : ownerId)
            );
          })
          .sort((a, b) => a.position - b.position || a.video_id.localeCompare(b.video_id))
          .map((pi) => ({
            video_id: pi.video_id,
            position: String(pi.position),
            added_at: pi.added_at,
          }));

        return { rows: playable, rowCount: playable.length };
      }

      // 5f. POSTS, REACTIONS, POST COMMENTS, FEEDS (SOC-2a)
      if (sql.includes('SELECT channel_id AS author_id FROM social.subscriptions')) {
        const callerId = String(params[0]);
        const subs = store.subscriptions
          .filter((s) => s.subscriber_id === callerId)
          .map((s) => ({ author_id: s.channel_id }));
        subs.push({ author_id: callerId });
        return { rows: subs, rowCount: subs.length };
      }

      if (sql.includes('SELECT blocked_id AS user_id FROM social.blocks')) {
        const callerId = String(params[0]);
        const blocked = store.blocks
          .filter((b) => b.blocker_id === callerId || b.blocked_id === callerId)
          .map((b) => ({ user_id: b.blocker_id === callerId ? b.blocked_id : b.blocker_id }));
        const muted = store.mutes
          .filter((m) => m.muter_id === callerId)
          .map((m) => ({ user_id: m.muted_id }));
        const rows = [...blocked, ...muted];
        return { rows, rowCount: rows.length };
      }

      if (sql.includes('public.winkey_tag_slug')) {
        const foldTag = (t: string) =>
          t
            .toLowerCase()
            .replace(/ß/g, 'ss')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[đĐ]/g, 'd')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

        if (sql.includes('unnest')) {
          const tags = (params[0] as string[]) || [];
          const rows = tags.map((t) => ({ tag: t, slug: foldTag(t) }));
          return { rows, rowCount: rows.length };
        }
        const tag = String(params[0] ?? '');
        const slug = foldTag(tag);
        return { rows: [{ slug }], rowCount: 1 };
      }

      if (
        sql.includes('insert into "social"."posts"') ||
        sql.includes('insert into social.posts')
      ) {
        const id = String(params[0]);
        const author_id = String(params[1]);
        const body = String(params[2] ?? '');
        const visibility = (params[3] ?? 'PUBLIC') as 'PUBLIC' | 'FOLLOWERS';
        const status = (params[4] ?? 'VISIBLE') as 'VISIBLE' | 'DELETED' | 'HIDDEN';
        const video_id = params[5] ? String(params[5]) : null;
        const reshare_of = params[6] ? String(params[6]) : null;
        const media_count = Number(params[7] ?? 0);
        const post = {
          id,
          author_id,
          body,
          visibility,
          status,
          video_id,
          reshare_of,
          media_count,
          reaction_count: 0,
          comment_count: 0,
          reshare_count: 0,
          created_at: new Date(),
          edited_at: null,
          updated_at: new Date(),
        };
        store.posts.push(post);
        return { rows: [post], rowCount: 1 };
      }

      if (sql.includes('update "social"."posts"') || sql.includes('update social.posts')) {
        const idParam = String(params[params.length - 1]);
        const post = store.posts.find((p) => p.id === idParam);
        if (post) {
          if (sql.includes('"status" =') || sql.includes('status =')) {
            const st = params.find((p) => p === 'VISIBLE' || p === 'HIDDEN' || p === 'DELETED');
            if (st) post.status = st as any;
          }
          if (sql.includes('"body" =') || sql.includes('body =')) {
            const b = params.find(
              (p) =>
                typeof p === 'string' &&
                p !== idParam &&
                p !== 'PUBLIC' &&
                p !== 'FOLLOWERS' &&
                p !== 'VISIBLE' &&
                p !== 'HIDDEN' &&
                p !== 'DELETED',
            );
            if (b !== undefined && b !== null) {
              post.body = String(b);
              post.edited_at = new Date();
            }
          }
          if (sql.includes('"visibility" =') || sql.includes('visibility =')) {
            const v = params.find((p) => p === 'PUBLIC' || p === 'FOLLOWERS');
            if (v) post.visibility = v as any;
          }
          post.updated_at = new Date();
          return { rows: [post], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (
        (sql.includes('from "social"."posts"') || sql.includes('from social.posts')) &&
        !sql.includes('join')
      ) {
        if (sql.includes('id = $1') || sql.includes('"id" = $1')) {
          const postId = String(params[0]);
          const post = store.posts.find((p) => p.id === postId);
          return {
            rows: post ? [{ ...post, created_at_cursor: post.created_at.toISOString() }] : [],
            rowCount: post ? 1 : 0,
          };
        }
        if (sql.includes('"id" in') || sql.includes('id in')) {
          const ids = (params as string[]).map(String);
          const rows = store.posts
            .filter((p) => ids.includes(p.id))
            .map((p) => ({ ...p, created_at_cursor: p.created_at.toISOString() }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('author_id = any') || sql.includes('"author_id" = any')) {
          const authors = (params[0] as string[]) || [];
          const rows = store.posts
            .filter((p) => authors.includes(p.author_id) && p.status === 'VISIBLE')
            .map((p) => ({ ...p, created_at_cursor: p.created_at.toISOString() }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('author_id = $1') || sql.includes('"author_id" = $1')) {
          const authorId = String(params[0]);
          const rows = store.posts
            .filter((p) => p.author_id === authorId && p.status === 'VISIBLE')
            .map((p) => ({ ...p, created_at_cursor: p.created_at.toISOString() }));
          return { rows, rowCount: rows.length };
        }
        const rows = store.posts.map((p) => ({
          ...p,
          created_at_cursor: p.created_at.toISOString(),
        }));
        return { rows, rowCount: rows.length };
      }

      if (sql.includes('post_hashtags') && !sql.includes('notifications')) {
        if (sql.includes('insert into') || sql.includes('INSERT INTO')) {
          for (let i = 0; i < params.length; i += 3) {
            const pid = String(params[i]);
            const tag = String(params[i + 1]);
            const slug = tag
              .toLowerCase()
              .replace(/ß/g, 'ss')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/[đĐ]/g, 'd')
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '');
            store.post_hashtags.push({ post_id: pid, tag, slug, created_at: new Date() });
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('delete from') || sql.includes('DELETE FROM')) {
          const pid = String(params[0]);
          store.post_hashtags = store.post_hashtags.filter((h) => h.post_id !== pid);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('group by') || sql.includes('GROUP BY')) {
          const counts = new Map<string, { tag: string; slug: string; count: number }>();
          for (const h of store.post_hashtags) {
            const entry = counts.get(h.slug) ?? { tag: h.tag, slug: h.slug, count: 0 };
            entry.count++;
            counts.set(h.slug, entry);
          }
          const rows = Array.from(counts.values()).map((e) => ({
            tag: e.tag,
            slug: e.slug,
            post_count: e.count,
          }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('join') || sql.includes('JOIN')) {
          const slugParam = String(params[0] ?? '');
          const matching = store.post_hashtags.filter((h) => h.slug === slugParam);
          const postIds = matching.map((h) => h.post_id);
          const posts = store.posts
            .filter((p) => postIds.includes(p.id) && p.status === 'VISIBLE')
            .map((p) => ({
              ...p,
              hashtag_created_at: new Date(),
              created_at_cursor: p.created_at.toISOString(),
            }));
          return { rows: posts, rowCount: posts.length };
        }
        if (sql.includes('"post_id" in') || sql.includes('post_id in')) {
          const ids = (params as string[]).map(String);
          const rows = store.post_hashtags.filter((h) => ids.includes(h.post_id));
          return { rows, rowCount: rows.length };
        }
        return { rows: store.post_hashtags, rowCount: store.post_hashtags.length };
      }

      if (sql.includes('post_mentions') && !sql.includes('notifications')) {
        if (sql.includes('insert into') || sql.includes('INSERT INTO')) {
          for (let i = 0; i < params.length; i += 2) {
            const pid = String(params[i]);
            const uid = String(params[i + 1]);
            store.post_mentions.push({ post_id: pid, user_id: uid });
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('delete from') || sql.includes('DELETE FROM')) {
          const pid = String(params[0]);
          store.post_mentions = store.post_mentions.filter((m) => m.post_id !== pid);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('join') || sql.includes('"post_id" in') || sql.includes('post_id in')) {
          const ids = (params as string[]).map(String);
          const rows = store.post_mentions
            .filter((m) => ids.includes(m.post_id))
            .map((m) => {
              const prof = store.public_profiles.find((p) => p.id === m.user_id);
              return {
                post_id: m.post_id,
                user_id: m.user_id,
                handle: prof?.handle ?? 'unknown',
              };
            });
          return { rows, rowCount: rows.length };
        }
        return { rows: store.post_mentions, rowCount: store.post_mentions.length };
      }

      if (sql.includes('post_reactions') && !sql.includes('notifications')) {
        if (sql.includes('insert into') || sql.includes('INSERT INTO')) {
          const postId = String(params[0]);
          const userId = String(params[1]);
          const reaction = params[2] as any;
          const existing = store.post_reactions.find(
            (r) => r.post_id === postId && r.user_id === userId,
          );
          if (existing) {
            existing.reaction = reaction;
          } else {
            store.post_reactions.push({
              post_id: postId,
              user_id: userId,
              reaction,
              created_at: new Date(),
            });
            const p = store.posts.find((x) => x.id === postId);
            if (p) p.reaction_count++;
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('delete from') || sql.includes('DELETE FROM')) {
          const postId = String(params[0]);
          const userId = String(params[1]);
          const idx = store.post_reactions.findIndex(
            (r) => r.post_id === postId && r.user_id === userId,
          );
          if (idx !== -1) {
            store.post_reactions.splice(idx, 1);
            const p = store.posts.find((x) => x.id === postId);
            if (p && p.reaction_count > 0) p.reaction_count--;
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('group by') || sql.includes('GROUP BY')) {
          const postId = String(params[0]);
          const reactions = store.post_reactions.filter((r) => r.post_id === postId);
          const counts = new Map<string, number>();
          for (const r of reactions) {
            counts.set(r.reaction, (counts.get(r.reaction) || 0) + 1);
          }
          const rows = Array.from(counts.entries()).map(([reaction, count]) => ({
            post_id: postId,
            reaction,
            count,
          }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('join') || sql.includes('JOIN')) {
          const postId = String(params[0]);
          const reactions = store.post_reactions.filter((r) => r.post_id === postId);
          const rows = reactions.map((r) => {
            const prof = store.public_profiles.find((p) => p.id === r.user_id);
            return {
              user_id: r.user_id,
              reaction: r.reaction,
              created_at: r.created_at,
              created_at_cursor: r.created_at.toISOString(),
              profile_id: prof?.id,
              profile_handle: prof?.handle,
              profile_display_name: prof?.display_name,
              profile_avatar_key: prof?.avatar_key,
              handle: prof?.handle,
              display_name: prof?.display_name,
              avatar_key: prof?.avatar_key,
              is_private: prof?.is_private ?? false,
            };
          });
          return { rows, rowCount: rows.length };
        }
        if (
          sql.includes('user_id = $1') &&
          (sql.includes('post_id in') || sql.includes('"post_id" in'))
        ) {
          const userId = String(params[0]);
          const postIds = (params.slice(1) as string[]).map(String);
          const rows = store.post_reactions.filter(
            (r) => r.user_id === userId && postIds.includes(r.post_id),
          );
          return { rows, rowCount: rows.length };
        }
        return { rows: store.post_reactions, rowCount: store.post_reactions.length };
      }

      if (sql.includes('post_comments') && !sql.includes('notifications')) {
        if (sql.includes('insert into') || sql.includes('INSERT INTO')) {
          const id = String(params[0]);
          const post_id = String(params[1]);
          const author_id = String(params[2]);
          const parent_id = params[3] ? String(params[3]) : null;
          const body = String(params[4] ?? '');
          const comment = {
            id,
            post_id,
            author_id,
            parent_id,
            body,
            status: 'VISIBLE' as const,
            reply_count: 0,
            created_at: new Date(),
            edited_at: null,
            updated_at: new Date(),
          };
          store.post_comments.push(comment);
          const p = store.posts.find((x) => x.id === post_id);
          if (p) p.comment_count++;
          return { rows: [comment], rowCount: 1 };
        }
        if (
          sql.includes('update "social"."post_comments"') ||
          sql.includes('update social.post_comments')
        ) {
          const commentId = String(params[params.length - 1]);
          const comment = store.post_comments.find((c) => c.id === commentId);
          if (comment) {
            if (sql.includes('status =') || sql.includes('"status" =')) {
              const st = params.find((p) => p === 'VISIBLE' || p === 'HIDDEN' || p === 'DELETED');
              if (st) comment.status = st as any;
            }
            if (sql.includes('body =') || sql.includes('"body" =')) {
              const b = params.find(
                (p) =>
                  typeof p === 'string' &&
                  p !== commentId &&
                  p !== 'VISIBLE' &&
                  p !== 'HIDDEN' &&
                  p !== 'DELETED',
              );
              if (b !== undefined && b !== null) {
                comment.body = String(b);
                comment.edited_at = new Date();
              }
            }
            comment.updated_at = new Date();
            return { rows: [comment], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('join') || sql.includes('JOIN')) {
          if (sql.includes('c.id = $1') || sql.includes('"c"."id" = $1')) {
            const commentId = String(params[0]);
            const c = store.post_comments.find((x) => x.id === commentId);
            if (!c) return { rows: [], rowCount: 0 };
            const prof = store.public_profiles.find((p) => p.id === c.author_id);
            const post = store.posts.find((p) => p.id === c.post_id);
            return {
              rows: [
                {
                  ...c,
                  post_author_id: post?.author_id,
                  profile_id: prof?.id,
                  profile_handle: prof?.handle,
                  profile_display_name: prof?.display_name,
                  profile_avatar_key: prof?.avatar_key,
                },
              ],
              rowCount: 1,
            };
          }
          const postId = String(params[0]);
          const comments = store.post_comments.filter(
            (c) => c.post_id === postId && c.status !== 'DELETED',
          );
          const rows = comments.map((c) => {
            const prof = store.public_profiles.find((p) => p.id === c.author_id);
            return {
              ...c,
              profile_id: prof?.id,
              profile_handle: prof?.handle,
              profile_display_name: prof?.display_name,
              profile_avatar_key: prof?.avatar_key,
            };
          });
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('id = $1') || sql.includes('"id" = $1')) {
          const commentId = String(params[0]);
          const comment = store.post_comments.find((c) => c.id === commentId);
          return { rows: comment ? [comment] : [], rowCount: comment ? 1 : 0 };
        }
        return { rows: store.post_comments, rowCount: store.post_comments.length };
      }

      if (sql.includes('post_scores') && !sql.includes('notifications')) {
        if (sql.includes('max(computed_at)')) {
          return { rows: [{ max_ts: new Date() }], rowCount: 1 };
        }
        if (sql.includes('join') || sql.includes('JOIN')) {
          const posts = store.posts.filter(
            (p) => p.status === 'VISIBLE' && p.visibility === 'PUBLIC',
          );
          const rows = posts.map((p) => ({
            ...p,
            score: 10,
            computed_at: new Date(),
          }));
          return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('post_media') && !sql.includes('notifications')) {
        if (sql.includes('insert into') || sql.includes('INSERT INTO')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('delete from') || sql.includes('DELETE FROM')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('"post_id" in') || sql.includes('post_id in')) {
          const ids = (params as string[]).map(String);
          const rows = store.post_media.filter((m) => ids.includes(m.post_id));
          return { rows, rowCount: rows.length };
        }
        return { rows: store.post_media, rowCount: store.post_media.length };
      }

      // 6. SELECT QUERIES
      // Select single video
      if (sql.includes('from "social"."videos"') || sql.includes('from social.videos')) {
        const videoId = String(params[0]);
        const video = store.videos.find((v) => v.id === videoId);
        return {
          rows: video
            ? [
                {
                  ...video,
                  hidden: video.hidden ?? false,
                  visibility: video.visibility ?? 'PUBLIC',
                },
              ]
            : [],
          rowCount: video ? 1 : 0,
        };
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
        if (sql.includes('lower(handle)')) {
          const lowerHandles = (params as string[]).map((h) => String(h).toLowerCase());
          const rows = store.public_profiles
            .filter((p) => lowerHandles.includes(p.handle.toLowerCase()))
            .map((p) => ({ id: p.id, handle: p.handle, is_private: p.is_private ?? false }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('"id" in') || sql.includes('id in')) {
          const ids = (params as string[]).map(String);
          const rows = store.public_profiles
            .filter((p) => ids.includes(p.id))
            .map((p) => ({
              id: p.id,
              handle: p.handle,
              display_name: p.display_name,
              avatar_key: p.avatar_key,
              is_private: p.is_private ?? false,
            }));
          return { rows, rowCount: rows.length };
        }
        const profileId = String(params[0]);
        const profile = store.public_profiles.find((p) => p.id === profileId);
        return {
          rows: profile
            ? [
                {
                  id: profile.id,
                  handle: profile.handle,
                  display_name: profile.display_name,
                  avatar_key: profile.avatar_key,
                  is_private: profile.is_private ?? false,
                },
              ]
            : [],
          rowCount: profile ? 1 : 0,
        };
      }

      // Check single like
      if (sql.includes('from "social"."video_likes"') || sql.includes('from social.video_likes')) {
        const [videoId, userId] = params as [string, string];
        const exists = store.video_likes.some(
          (vl) => vl.video_id === videoId && vl.user_id === userId,
        );
        return { rows: exists ? [{ one: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // Subscriptions keyset paging (fanout)
      if (
        (sql.includes('from "social"."subscriptions"') ||
          sql.includes('from social.subscriptions')) &&
        !sql.toLowerCase().includes('join') &&
        sql.includes('"channel_id" = $1') &&
        sql.includes('order by')
      ) {
        const channelId = String(params[0]);
        let matched = store.subscriptions.filter((s) => s.channel_id === channelId);
        if (sql.includes('"subscriber_id" > $2')) {
          const lastId = String(params[1]);
          matched = matched.filter((s) => s.subscriber_id > lastId);
        }
        matched.sort((a, b) => a.subscriber_id.localeCompare(b.subscriber_id));
        const limitParam = params.find((p) => typeof p === 'number');
        if (typeof limitParam === 'number') {
          matched = matched.slice(0, limitParam);
        }
        return {
          rows: matched.map((s) => ({ subscriber_id: s.subscriber_id })),
          rowCount: matched.length,
        };
      }

      // Check subscription
      if (sql.includes('from "social"."subscriptions"') && !sql.includes('join')) {
        const [subscriberId, channelId] = params as [string, string];
        const exists = store.subscriptions.some(
          (s) => s.subscriber_id === subscriberId && s.channel_id === channelId,
        );
        return { rows: exists ? [{ one: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // List my subscriptions / followers / following (joined with public_profiles)
      if (
        (sql.includes('from "social"."subscriptions"') ||
          sql.includes('from social.subscriptions')) &&
        (sql.includes('"auth"."public_profiles"') || sql.includes('auth.public_profiles'))
      ) {
        if (sql.includes('"s"."channel_id" =') || sql.includes('s.channel_id =')) {
          // List followers
          const channelId = String(params[0]);
          let matched = store.subscriptions.filter((s) => s.channel_id === channelId);

          // Caller block check
          const callerParam =
            sql.includes('social.blocks') && params.length >= 3 ? String(params[1]) : undefined;
          if (callerParam) {
            matched = matched.filter(
              (s) =>
                !store.blocks.some(
                  (b) =>
                    (b.blocker_id === callerParam && b.blocked_id === s.subscriber_id) ||
                    (b.blocker_id === s.subscriber_id && b.blocked_id === callerParam),
                ),
            );
          }

          if (sql.includes('s.created_at <') && sql.includes('s.subscriber_id <')) {
            const dateParam = params.find(
              (p): p is string =>
                typeof p === 'string' &&
                !isNaN(Date.parse(p)) &&
                (p.includes('T') || p.includes(' ')),
            );
            const cursorCreatedAt = dateParam ? new Date(dateParam) : new Date();
            const uuidParams = params.filter(
              (p): p is string =>
                typeof p === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p) &&
                p !== channelId &&
                p !== callerParam,
            );
            const cursorId = uuidParams[uuidParams.length - 1];
            matched = matched.filter((s) => {
              if (s.created_at.getTime() < cursorCreatedAt.getTime()) return true;
              if (
                s.created_at.getTime() === cursorCreatedAt.getTime() &&
                cursorId &&
                s.subscriber_id < cursorId
              )
                return true;
              return false;
            });
          }

          matched.sort(
            (a, b) =>
              b.created_at.getTime() - a.created_at.getTime() ||
              b.subscriber_id.localeCompare(a.subscriber_id),
          );

          const limitParam = params.find((p) => typeof p === 'number' && p > 0);
          if (typeof limitParam === 'number') {
            matched = matched.slice(0, limitParam);
          }

          const joined = matched
            .map((s) => {
              const p = store.public_profiles.find((prof) => prof.id === s.subscriber_id);
              if (!p) return null;
              return {
                subscriber_id: s.subscriber_id,
                followed_at: s.created_at,
                followed_at_cursor: s.created_at_micros ?? s.created_at.toISOString(),
                profile_id: p.id,
                profile_handle: p.handle,
                profile_display_name: p.display_name,
                profile_avatar_key: p.avatar_key,
              };
            })
            .filter(Boolean);

          return { rows: joined, rowCount: joined.length };
        }

        if (sql.includes('followed_at')) {
          // List following
          const subscriberId = String(params[0]);
          let matched = store.subscriptions.filter((s) => s.subscriber_id === subscriberId);

          const callerParam =
            sql.includes('social.blocks') && params.length >= 3 ? String(params[1]) : undefined;
          if (callerParam) {
            matched = matched.filter(
              (s) =>
                !store.blocks.some(
                  (b) =>
                    (b.blocker_id === callerParam && b.blocked_id === s.channel_id) ||
                    (b.blocker_id === s.channel_id && b.blocked_id === callerParam),
                ),
            );
          }

          if (sql.includes('s.created_at <') && sql.includes('s.channel_id <')) {
            const dateParam = params.find(
              (p): p is string =>
                typeof p === 'string' &&
                !isNaN(Date.parse(p)) &&
                (p.includes('T') || p.includes(' ')),
            );
            const cursorCreatedAt = dateParam ? new Date(dateParam) : new Date();
            const uuidParams = params.filter(
              (p): p is string =>
                typeof p === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p) &&
                p !== subscriberId &&
                p !== callerParam,
            );
            const cursorId = uuidParams[uuidParams.length - 1];
            matched = matched.filter((s) => {
              if (s.created_at.getTime() < cursorCreatedAt.getTime()) return true;
              if (
                s.created_at.getTime() === cursorCreatedAt.getTime() &&
                cursorId &&
                s.channel_id < cursorId
              )
                return true;
              return false;
            });
          }

          matched.sort(
            (a, b) =>
              b.created_at.getTime() - a.created_at.getTime() ||
              b.channel_id.localeCompare(a.channel_id),
          );

          const limitParam = params.find((p) => typeof p === 'number' && p > 0);
          if (typeof limitParam === 'number') {
            matched = matched.slice(0, limitParam);
          }

          const joined = matched
            .map((s) => {
              const p = store.public_profiles.find((prof) => prof.id === s.channel_id);
              if (!p) return null;
              return {
                channel_id: s.channel_id,
                followed_at: s.created_at,
                followed_at_cursor: s.created_at_micros ?? s.created_at.toISOString(),
                profile_id: p.id,
                profile_handle: p.handle,
                profile_display_name: p.display_name,
                profile_avatar_key: p.avatar_key,
              };
            })
            .filter(Boolean);

          return { rows: joined, rowCount: joined.length };
        }

        // List my subscriptions
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

      // Follow requests queries
      if (
        /from\s+("?social"?\.)?"?follow_requests"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?notifications"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?subscriptions"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?comments"?/i.test(sql)
      ) {
        if (sql.includes('count(*)::int')) {
          if (sql.includes('requester_id =') && !sql.includes('target_id =')) {
            const requesterId = String(params[0]);
            const count = store.follow_requests.filter(
              (fr) => fr.requester_id === requesterId,
            ).length;
            return { rows: [{ count }], rowCount: 1 };
          }
          const targetId = String(params[0]);
          let matched = store.follow_requests.filter((fr) => fr.target_id === targetId);
          // Filter inactive profiles and blocks if caller blocks
          matched = matched.filter((fr) => {
            const p = store.public_profiles.find((prof) => prof.id === fr.requester_id);
            if (!p) return false;
            if (
              store.blocks.some(
                (b) =>
                  (b.blocker_id === targetId && b.blocked_id === fr.requester_id) ||
                  (b.blocker_id === fr.requester_id && b.blocked_id === targetId),
              )
            ) {
              return false;
            }
            return true;
          });
          return { rows: [{ count: matched.length }], rowCount: 1 };
        }

        if (sql.includes('"auth"."public_profiles"') || sql.includes('auth.public_profiles')) {
          const targetId = String(params[0]);
          let matched = store.follow_requests.filter((fr) => fr.target_id === targetId);
          matched = matched.filter((fr) => {
            const p = store.public_profiles.find((prof) => prof.id === fr.requester_id);
            if (!p) return false;
            if (
              store.blocks.some(
                (b) =>
                  (b.blocker_id === targetId && b.blocked_id === fr.requester_id) ||
                  (b.blocker_id === fr.requester_id && b.blocked_id === targetId),
              )
            ) {
              return false;
            }
            return true;
          });

          if (sql.includes('fr.created_at <') && sql.includes('fr.requester_id <')) {
            const dateParam = params.find(
              (p): p is string =>
                typeof p === 'string' &&
                !isNaN(Date.parse(p)) &&
                (p.includes('T') || p.includes(' ')),
            );
            const cursorCreatedAt = dateParam ? new Date(dateParam) : new Date();
            const uuidParams = params.filter(
              (p): p is string =>
                typeof p === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p) &&
                p !== targetId,
            );
            const cursorId = uuidParams[uuidParams.length - 1];
            matched = matched.filter((fr) => {
              if (fr.created_at.getTime() < cursorCreatedAt.getTime()) return true;
              if (
                fr.created_at.getTime() === cursorCreatedAt.getTime() &&
                cursorId &&
                fr.requester_id < cursorId
              )
                return true;
              return false;
            });
          }

          matched.sort(
            (a, b) =>
              b.created_at.getTime() - a.created_at.getTime() ||
              b.requester_id.localeCompare(a.requester_id),
          );

          const limitParam = params.find((p) => typeof p === 'number' && p > 0);
          if (typeof limitParam === 'number') {
            matched = matched.slice(0, limitParam);
          }

          const joined = matched
            .map((fr) => {
              const p = store.public_profiles.find((prof) => prof.id === fr.requester_id);
              if (!p) return null;
              return {
                requester_id: fr.requester_id,
                requested_at: fr.created_at,
                requested_at_cursor: fr.created_at_micros ?? fr.created_at.toISOString(),
                profile_id: p.id,
                profile_handle: p.handle,
                profile_display_name: p.display_name,
                profile_avatar_key: p.avatar_key,
              };
            })
            .filter(Boolean);

          return { rows: joined, rowCount: joined.length };
        }

        // Single check
        const [requesterId, targetId] = params as [string, string];
        const exists = store.follow_requests.some(
          (fr) => fr.requester_id === requesterId && fr.target_id === targetId,
        );
        return { rows: exists ? [{ one: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // Blocks queries
      if (
        /from\s+("?social"?\.)?"?blocks"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?notifications"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?subscriptions"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?comments"?/i.test(sql)
      ) {
        if (sql.includes('count(*)::int')) {
          const blockerId = String(params[0]);
          const count = store.blocks.filter((b) => b.blocker_id === blockerId).length;
          return { rows: [{ count }], rowCount: 1 };
        }

        if (sql.includes('"auth"."public_profiles"') || sql.includes('auth.public_profiles')) {
          const blockerId = String(params[0]);
          let matched = store.blocks.filter((b) => b.blocker_id === blockerId);

          if (sql.includes('b.created_at <') && sql.includes('b.blocked_id <')) {
            const dateParam = params.find(
              (p): p is string =>
                typeof p === 'string' &&
                !isNaN(Date.parse(p)) &&
                (p.includes('T') || p.includes(' ')),
            );
            const cursorCreatedAt = dateParam ? new Date(dateParam) : new Date();
            const uuidParams = params.filter(
              (p): p is string =>
                typeof p === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p) &&
                p !== blockerId,
            );
            const cursorId = uuidParams[uuidParams.length - 1];
            matched = matched.filter((b) => {
              if (b.created_at.getTime() < cursorCreatedAt.getTime()) return true;
              if (
                b.created_at.getTime() === cursorCreatedAt.getTime() &&
                cursorId &&
                b.blocked_id < cursorId
              )
                return true;
              return false;
            });
          }

          matched.sort(
            (a, b) =>
              b.created_at.getTime() - a.created_at.getTime() ||
              b.blocked_id.localeCompare(a.blocked_id),
          );

          const limitParam = params.find((p) => typeof p === 'number' && p > 0);
          if (typeof limitParam === 'number') {
            matched = matched.slice(0, limitParam);
          }

          const joined = matched
            .map((b) => {
              const p = store.public_profiles.find((prof) => prof.id === b.blocked_id);
              if (!p) return null;
              return {
                blocked_id: b.blocked_id,
                since: b.created_at,
                since_cursor: b.created_at_micros ?? b.created_at.toISOString(),
                profile_id: p.id,
                profile_handle: p.handle,
                profile_display_name: p.display_name,
                profile_avatar_key: p.avatar_key,
              };
            })
            .filter(Boolean);

          return { rows: joined, rowCount: joined.length };
        }

        // Single / either-way check
        const [userA, userB] = params as [string, string];
        const isEitherWay = sql.includes('OR') || sql.includes('or');
        const exists = store.blocks.some(
          (b) =>
            (b.blocker_id === userA && b.blocked_id === userB) ||
            (isEitherWay && b.blocker_id === userB && b.blocked_id === userA),
        );
        return { rows: exists ? [{ blocked: 1, one: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // Mutes queries
      if (
        /from\s+("?social"?\.)?"?mutes"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?notifications"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?subscriptions"?/i.test(sql) &&
        !/from\s+("?social"?\.)?"?comments"?/i.test(sql)
      ) {
        if (sql.includes('count(*)::int')) {
          const muterId = String(params[0]);
          const count = store.mutes.filter((m) => m.muter_id === muterId).length;
          return { rows: [{ count }], rowCount: 1 };
        }

        if (sql.includes('"auth"."public_profiles"') || sql.includes('auth.public_profiles')) {
          const muterId = String(params[0]);
          let matched = store.mutes.filter((m) => m.muter_id === muterId);

          if (sql.includes('m.created_at <') && sql.includes('m.muted_id <')) {
            const dateParam = params.find(
              (p): p is string =>
                typeof p === 'string' &&
                !isNaN(Date.parse(p)) &&
                (p.includes('T') || p.includes(' ')),
            );
            const cursorCreatedAt = dateParam ? new Date(dateParam) : new Date();
            const uuidParams = params.filter(
              (p): p is string =>
                typeof p === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p) &&
                p !== muterId,
            );
            const cursorId = uuidParams[uuidParams.length - 1];
            matched = matched.filter((m) => {
              if (m.created_at.getTime() < cursorCreatedAt.getTime()) return true;
              if (
                m.created_at.getTime() === cursorCreatedAt.getTime() &&
                cursorId &&
                m.muted_id < cursorId
              )
                return true;
              return false;
            });
          }

          matched.sort(
            (a, b) =>
              b.created_at.getTime() - a.created_at.getTime() ||
              b.muted_id.localeCompare(a.muted_id),
          );

          const limitParam = params.find((p) => typeof p === 'number' && p > 0);
          if (typeof limitParam === 'number') {
            matched = matched.slice(0, limitParam);
          }

          const joined = matched
            .map((m) => {
              const p = store.public_profiles.find((prof) => prof.id === m.muted_id);
              if (!p) return null;
              return {
                muted_id: m.muted_id,
                since: m.created_at,
                since_cursor: m.created_at_micros ?? m.created_at.toISOString(),
                profile_id: p.id,
                profile_handle: p.handle,
                profile_display_name: p.display_name,
                profile_avatar_key: p.avatar_key,
              };
            })
            .filter(Boolean);

          return { rows: joined, rowCount: joined.length };
        }

        // Single check
        const [muterId, mutedId] = params as [string, string];
        const exists = store.mutes.some((m) => m.muter_id === muterId && m.muted_id === mutedId);
        return { rows: exists ? [{ muted: 1, one: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      // Reports: Select duplicate OPEN report
      if (
        (sql.includes('from "social"."reports"') || sql.includes('from social.reports')) &&
        sql.includes('"reporter_id" = $1')
      ) {
        const [reporterId, targetType, targetId, status] = params as [
          string,
          string,
          string,
          string,
        ];
        const report = store.reports.find(
          (r) =>
            r.reporter_id === reporterId &&
            r.target_type === targetType &&
            r.target_id === targetId &&
            r.status === status,
        );
        if (report) {
          return {
            rows: [{ id: report.id, created_at_iso: report.created_at.toISOString() }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // Reports: Moderation queue grouped query
      if (
        (sql.includes('from "social"."reports"') || sql.includes('from social.reports')) &&
        sql.includes('group by "target_type", "target_id", "status"')
      ) {
        const statusParam = (params.find((p) =>
          ['OPEN', 'ACTIONED', 'DISMISSED'].includes(p as string),
        ) ?? 'OPEN') as 'OPEN' | 'ACTIONED' | 'DISMISSED';
        const targetTypeParam = params.find((p) =>
          ['VIDEO', 'COMMENT', 'USER'].includes(p as string),
        ) as 'VIDEO' | 'COMMENT' | 'USER' | undefined;

        let filtered = store.reports.filter((r) => r.status === statusParam);
        if (targetTypeParam) {
          filtered = filtered.filter((r) => r.target_type === targetTypeParam);
        }

        const groupsMap = new Map<
          string,
          {
            target_type: string;
            target_id: string;
            status: string;
            open_count: number;
            first_reported_at: Date;
            resolved_at: Date | null;
            resolved_by: string | null;
            resolution_note: string | null;
          }
        >();

        for (const r of filtered) {
          const key = `${r.target_type}::${r.target_id}::${r.status}`;
          let g = groupsMap.get(key);
          if (!g) {
            g = {
              target_type: r.target_type,
              target_id: r.target_id,
              status: r.status,
              open_count: 0,
              first_reported_at: r.created_at,
              resolved_at: r.resolved_at,
              resolved_by: r.resolved_by,
              resolution_note: r.resolution_note,
            };
            groupsMap.set(key, g);
          }
          if (r.status === 'OPEN') g.open_count++;
          if (r.created_at < g.first_reported_at) g.first_reported_at = r.created_at;
          if (r.resolved_at && (!g.resolved_at || r.resolved_at > g.resolved_at)) {
            g.resolved_at = r.resolved_at;
            g.resolved_by = r.resolved_by;
            g.resolution_note = r.resolution_note;
          }
        }

        const list = Array.from(groupsMap.values());
        if (statusParam === 'OPEN') {
          list.sort(
            (a, b) =>
              a.first_reported_at.getTime() - b.first_reported_at.getTime() ||
              a.target_id.localeCompare(b.target_id),
          );
        } else {
          list.sort(
            (a, b) =>
              (b.resolved_at?.getTime() ?? 0) - (a.resolved_at?.getTime() ?? 0) ||
              b.target_id.localeCompare(a.target_id),
          );
        }

        const rows = list.map((g) => ({
          target_type: g.target_type,
          target_id: g.target_id,
          status: g.status,
          open_count: g.open_count,
          first_reported_at_iso: g.first_reported_at.toISOString(),
          resolved_at_iso: g.resolved_at ? g.resolved_at.toISOString() : null,
          resolved_by: g.resolved_by,
          resolution_note: g.resolution_note,
        }));
        return { rows, rowCount: rows.length };
      }

      // Reports: Reasons histogram
      if (
        (sql.includes('from "social"."reports"') || sql.includes('from social.reports')) &&
        sql.includes('group by "reason"')
      ) {
        const [targetType, targetId, status] = params as [string, string, string];
        const reports = store.reports.filter(
          (r) => r.target_type === targetType && r.target_id === targetId && r.status === status,
        );
        const countMap = new Map<string, number>();
        for (const r of reports) {
          countMap.set(r.reason, (countMap.get(r.reason) ?? 0) + 1);
        }
        const rows = Array.from(countMap.entries()).map(([reason, count]) => ({ reason, count }));
        return { rows, rowCount: rows.length };
      }

      // Reports: Recent 5 reports with profile
      if (
        sql.includes('from "social"."reports" as "r"') &&
        sql.includes('"auth"."public_profiles" as "p"')
      ) {
        const [targetType, targetId, status] = params as [string, string, string];
        const matched = store.reports
          .filter(
            (r) => r.target_type === targetType && r.target_id === targetId && r.status === status,
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .slice(0, 5);

        const rows = matched.map((r) => {
          const profile = store.public_profiles.find((p) => p.id === r.reporter_id);
          return {
            id: r.id,
            reason: r.reason,
            note: r.note,
            status: r.status,
            created_at_iso: r.created_at.toISOString(),
            profile_id: profile?.id ?? null,
            profile_handle: profile?.handle ?? null,
            profile_display_name: profile?.display_name ?? null,
            profile_avatar_key: profile?.avatar_key ?? null,
          };
        });
        return { rows, rowCount: rows.length };
      }

      // Select single comment (deep link / join)
      if (
        (sql.includes('from "social"."comments"') || sql.includes('from social.comments')) &&
        (sql.includes('where "c"."id" = $1') || sql.includes('where "id" = $1'))
      ) {
        const commentId = String(params[0]);
        const comment = store.comments.find((c) => c.id === commentId);
        if (!comment) return { rows: [], rowCount: 0 };

        const video = store.videos.find((v) => v.id === comment.video_id);
        const profile = store.public_profiles.find((p) => p.id === comment.author_id);

        const row = {
          ...comment,
          created_at_cursor: comment.created_at.toISOString(),
          video_owner_id: video?.owner_id,
          video_hidden: video?.hidden ?? false,
          video_visibility: video?.visibility ?? 'PUBLIC',
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

      // Notifications unread count
      if (
        /from\s+("?social"?\.)?"?notifications"?\s+n/i.test(sql) &&
        /count\(\*\)::int/i.test(sql)
      ) {
        const userId = String(params[0]);
        const matched = store.notifications.filter((n) => {
          if (n.user_id !== userId) return false;
          if (n.read_at !== null) return false;
          if (n.video_id) {
            const v = store.videos.find((vid) => vid.id === n.video_id);
            if (!v || v.hidden || v.visibility === 'PRIVATE') return false;
          }
          if (n.comment_id) {
            const c = store.comments.find((comm) => comm.id === n.comment_id);
            if (!c || c.status !== 'VISIBLE') return false;
          }
          const p = store.public_profiles.find((prof) => prof.id === n.actor_id);
          if (!p) return false;
          return true;
        });

        const count = Math.min(matched.length, 101);
        return { rows: [{ count }], rowCount: 1 };
      }

      // Notifications list (joined with profiles, videos, comments)
      if (
        sql.includes('from "social"."notifications" as "n"') ||
        sql.includes('from social.notifications as n') ||
        sql.includes('from social.notifications n')
      ) {
        const userId = String(params[0]);
        const unreadOnly =
          sql.includes('"n"."read_at" is null') ||
          sql.includes('n.read_at IS NULL') ||
          sql.includes('n.read_at is null');

        let matched = store.notifications.filter((n) => {
          if (n.user_id !== userId) return false;
          if (unreadOnly && n.read_at !== null) return false;
          if (n.video_id) {
            const v = store.videos.find((vid) => vid.id === n.video_id);
            if (!v || v.hidden || v.visibility === 'PRIVATE') return false;
          }
          if (n.comment_id) {
            const c = store.comments.find((comm) => comm.id === n.comment_id);
            if (!c || c.status !== 'VISIBLE') return false;
          }
          const p = store.public_profiles.find((prof) => prof.id === n.actor_id);
          if (!p) return false;
          if (
            store.blocks.some(
              (b) =>
                (b.blocker_id === userId && b.blocked_id === n.actor_id) ||
                (b.blocker_id === n.actor_id && b.blocked_id === userId),
            )
          ) {
            return false;
          }
          return true;
        });

        if (sql.includes('n.created_at <') && sql.includes('n.id <')) {
          const dateParam = params.find(
            (p): p is string =>
              typeof p === 'string' &&
              !isNaN(Date.parse(p)) &&
              (p.includes('T') || p.includes(' ')),
          );
          const cursorCreatedAt = dateParam ? new Date(dateParam) : new Date(String(params[1]));
          const uuidParams = params.filter(
            (p): p is string =>
              typeof p === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p) &&
              p !== userId,
          );
          const cursorId = uuidParams[uuidParams.length - 1] ?? String(params[3]);
          matched = matched.filter((n) => {
            if (n.created_at.getTime() < cursorCreatedAt.getTime()) return true;
            if (n.created_at.getTime() === cursorCreatedAt.getTime() && n.id < cursorId)
              return true;
            return false;
          });
        }

        matched.sort(
          (a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id),
        );

        const limitParam = params.find((p) => typeof p === 'number' && p > 0 && p <= 101);
        if (typeof limitParam === 'number') {
          matched = matched.slice(0, limitParam);
        }

        const rows = matched.map((n) => {
          const p = store.public_profiles.find((prof) => prof.id === n.actor_id);
          const cursorMicros =
            (n as any).created_at_micros ??
            n.created_at.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
          return {
            id: n.id,
            kind: n.kind,
            actor_id: n.actor_id,
            video_id: n.video_id,
            comment_id: n.comment_id,
            created_at: n.created_at,
            read_at: n.read_at,
            created_at_cursor: cursorMicros,
            profile_id: p?.id,
            profile_handle: p?.handle,
            profile_display_name: p?.display_name,
            profile_avatar_key: p?.avatar_key,
          };
        });

        return { rows, rowCount: rows.length };
      }

      // Playlists: Count for owner
      if (/from\s+("?social"?\.)?"?playlists"?/i.test(sql) && /count\(\*\)::int/i.test(sql)) {
        const ownerId = String(params[0]);
        const count = store.playlists.filter((p) => p.owner_id === ownerId).length;
        return { rows: [{ count }], rowCount: 1 };
      }

      // Playlist items: Max position
      if (
        /from\s+("?social"?\.)?"?playlist_items"?/i.test(sql) &&
        /max\("?position"?\)/i.test(sql)
      ) {
        const playlistId = String(params[0]);
        const items = store.playlist_items.filter((i) => i.playlist_id === playlistId);
        if (items.length === 0) {
          return { rows: [{ max_pos: null }], rowCount: 1 };
        }
        const maxPos = Math.max(...items.map((i) => i.position));
        return { rows: [{ max_pos: String(maxPos) }], rowCount: 1 };
      }

      // Playlist items: Single item check (playlist_id & video_id)
      if (
        /from\s+("?social"?\.)?"?playlist_items"?/i.test(sql) &&
        !sql.includes('join') &&
        sql.includes('"playlist_id" =') &&
        sql.includes('"video_id" =')
      ) {
        const playlistId = String(params[0]);
        const videoId = String(params[1]);
        const item = store.playlist_items.find(
          (i) => i.playlist_id === playlistId && i.video_id === videoId,
        );
        return { rows: item ? [item] : [], rowCount: item ? 1 : 0 };
      }

      // Playlist items: Order by position (for move reordering)
      if (
        /from\s+("?social"?\.)?"?playlist_items"?/i.test(sql) &&
        !sql.includes('join') &&
        sql.includes('order by')
      ) {
        const playlistId = String(params[0]);
        const items = store.playlist_items
          .filter((i) => i.playlist_id === playlistId)
          .sort((a, b) => a.position - b.position);
        return { rows: items, rowCount: items.length };
      }

      // Playlist items: Joined with videos (listPlaylistItems)
      if (
        sql.includes('from "social"."playlist_items" as "pi"') &&
        sql.includes('join "social"."videos" as "v"')
      ) {
        const playlistId = String(params[0]);
        const callerId = params.find(
          (p) => typeof p === 'string' && p.includes('-') && p !== playlistId,
        ) as string | undefined;

        let items = store.playlist_items
          .filter((pi) => pi.playlist_id === playlistId)
          .filter((pi) => {
            const v = store.videos.find((vid) => vid.id === pi.video_id);
            if (!v) return false;
            const isOwner = Boolean(callerId && v.owner_id === callerId);
            if (isOwner) return true;
            return !v.hidden && v.visibility !== 'PRIVATE';
          })
          .sort((a, b) => a.position - b.position);

        if (sql.includes('"pi"."position" >')) {
          const cursorParam = params.find(
            (p) =>
              (typeof p === 'string' && /^\d+$/.test(p)) || (typeof p === 'number' && p > 1000),
          );
          if (cursorParam !== undefined) {
            const cursorPos = Number(cursorParam);
            items = items.filter((i) => i.position > cursorPos);
          }
        }

        const limitParam = params.find((p) => typeof p === 'number' && p <= 101);
        if (typeof limitParam === 'number') {
          items = items.slice(0, limitParam);
        }

        const mapped = items.map((i) => ({
          video_id: i.video_id,
          position: i.position,
          added_at: i.added_at,
        }));
        return { rows: mapped, rowCount: mapped.length };
      }

      // Self-move or single item check with owner
      if (
        sql.includes('from "social"."playlist_items" as "pi"') &&
        sql.includes('join "social"."playlists" as "p"') &&
        sql.includes('"pi"."playlist_id" =')
      ) {
        const playlistId = String(params[0]);
        const videoId = String(params[1]);
        const item = store.playlist_items.find(
          (pi) => pi.playlist_id === playlistId && pi.video_id === videoId,
        );
        const pl = store.playlists.find((p) => p.id === playlistId);
        if (item && pl) {
          return {
            rows: [
              {
                video_id: item.video_id,
                position: item.position,
                added_at: item.added_at,
                owner_id: pl.owner_id,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // Playlist membership: Which of caller's playlists contain video_id
      if (
        sql.includes('from "social"."playlist_items" as "pi"') &&
        sql.includes('join "social"."playlists" as "p"') &&
        sql.includes('"p"."owner_id" =')
      ) {
        const callerId = String(params[0]);
        const videoId = String(params[1]);
        const matching = store.playlist_items
          .filter((pi) => {
            if (pi.video_id !== videoId) return false;
            const p = store.playlists.find((pl) => pl.id === pi.playlist_id);
            return p && p.owner_id === callerId;
          })
          .sort((a, b) => b.added_at.getTime() - a.added_at.getTime());

        const rows = matching.map((pi) => ({ playlist_id: pi.playlist_id }));
        return { rows, rowCount: rows.length };
      }

      // Single playlist query: joined with public_profiles by id
      if (
        sql.includes('from "social"."playlists" as "p"') &&
        sql.includes('join "auth"."public_profiles" as "prof"') &&
        sql.includes('"p"."id" =')
      ) {
        const playlistId = String(params[0]);
        const pl = store.playlists.find((p) => p.id === playlistId);
        if (!pl) return { rows: [], rowCount: 0 };
        const prof = store.public_profiles.find((pr) => pr.id === pl.owner_id);
        return {
          rows: [
            {
              id: pl.id,
              owner_id: pl.owner_id,
              kind: pl.kind,
              title: pl.title,
              description: pl.description,
              visibility: pl.visibility,
              item_count: pl.item_count,
              created_at: pl.created_at,
              updated_at: pl.updated_at,
              prof_id: prof?.id,
              prof_handle: prof?.handle,
              prof_display_name: prof?.display_name,
              prof_avatar_key: prof?.avatar_key,
              is_series: pl.is_series ?? false,
            },
          ],
          rowCount: 1,
        };
      }

      // Watch-later query: joined with public_profiles by kind
      if (
        sql.includes('from "social"."playlists" as "p"') &&
        sql.includes('join "auth"."public_profiles" as "prof"') &&
        sql.includes('"p"."kind" =')
      ) {
        const ownerId = String(params[0]);
        const pl = store.playlists.find((p) => p.owner_id === ownerId && p.kind === 'WATCH_LATER');
        if (!pl) return { rows: [], rowCount: 0 };
        const prof = store.public_profiles.find((pr) => pr.id === pl.owner_id);
        return {
          rows: [
            {
              id: pl.id,
              owner_id: pl.owner_id,
              kind: pl.kind,
              title: pl.title,
              description: pl.description,
              visibility: pl.visibility,
              item_count: pl.item_count,
              created_at: pl.created_at,
              updated_at: pl.updated_at,
              prof_id: prof?.id,
              prof_handle: prof?.handle,
              prof_display_name: prof?.display_name,
              prof_avatar_key: prof?.avatar_key,
              is_series: false,
            },
          ],
          rowCount: 1,
        };
      }

      // Channel playlists: joined with public_profiles by owner_id
      if (
        sql.includes('from "social"."playlists" as "p"') &&
        sql.includes('join "auth"."public_profiles" as "prof"') &&
        sql.includes('"p"."owner_id" =')
      ) {
        const channelId = String(params[0]);
        const isOwner = !sql.includes('"p"."visibility" =');
        let matched = store.playlists.filter((p) => p.owner_id === channelId);
        if (!isOwner) {
          matched = matched.filter((p) => p.visibility === 'PUBLIC' && p.kind !== 'WATCH_LATER');
        }
        if (isOwner) {
          matched.sort((a, b) => {
            const aWl = a.kind === 'WATCH_LATER' ? 0 : 1;
            const bWl = b.kind === 'WATCH_LATER' ? 0 : 1;
            if (aWl !== bWl) return aWl - bWl;
            return b.updated_at.getTime() - a.updated_at.getTime() || b.id.localeCompare(a.id);
          });
        } else {
          matched.sort(
            (a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.id.localeCompare(a.id),
          );
        }

        if (sql.includes('p.updated_at <')) {
          const cursorDateStr = params.find(
            (p) => typeof p === 'string' && p.includes('T') && p.includes('Z'),
          ) as string | undefined;
          const cursorId = params.find(
            (p) =>
              typeof p === 'string' && p.includes('-') && p !== channelId && p !== cursorDateStr,
          ) as string | undefined;
          if (cursorDateStr && cursorId) {
            const cursorDate = new Date(cursorDateStr);
            matched = matched.filter((p) => {
              const pTime = p.updated_at.getTime();
              const cTime = cursorDate.getTime();
              if (pTime < cTime) return true;
              if (pTime === cTime && p.id < cursorId) return true;
              return false;
            });
          }
        }

        const limitParam = params.find((p) => typeof p === 'number');
        if (typeof limitParam === 'number') {
          matched = matched.slice(0, limitParam);
        }

        const rows = matched.map((pl) => {
          const prof = store.public_profiles.find((pr) => pr.id === pl.owner_id);
          return {
            id: pl.id,
            owner_id: pl.owner_id,
            kind: pl.kind,
            title: pl.title,
            description: pl.description,
            visibility: pl.visibility,
            item_count: pl.item_count,
            created_at: pl.created_at,
            updated_at: pl.updated_at,
            updated_at_cursor: pl.updated_at.toISOString(),
            prof_id: prof?.id,
            prof_handle: prof?.handle,
            prof_display_name: prof?.display_name,
            prof_avatar_key: prof?.avatar_key,
            is_series: pl.is_series ?? false,
          };
        });
        return { rows, rowCount: rows.length };
      }

      // Plain playlist query: from social.playlists where id = $1
      if (
        (sql.includes('from "social"."playlists"') || sql.includes('from social.playlists')) &&
        (sql.includes('"id" =') || sql.includes('id ='))
      ) {
        const playlistId = String(params[0]);
        const pl = store.playlists.find((p) => p.id === playlistId);
        return {
          rows: pl ? [{ ...pl, is_series: pl.is_series ?? false }] : [],
          rowCount: pl ? 1 : 0,
        };
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
