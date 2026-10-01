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
  advisory_locks: Set<number>;
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
    reports: [],
    notifications: [],
    playlists: [],
    playlist_items: [],
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
        const itemCount = Number(params[6] ?? 0);
        const now = new Date();

        const newPl = {
          id,
          owner_id: ownerId,
          kind,
          title,
          description,
          visibility,
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
          return { rows: [pl], rowCount: 1 };
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

      // Subscriptions keyset paging (fanout)
      if (
        (sql.includes('from "social"."subscriptions"') ||
          sql.includes('from social.subscriptions')) &&
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
          return true;
        });

        if (sql.includes('n.created_at <') && sql.includes('n.id <')) {
          // Cursor params: params contains [userId, cursorCreatedAt, cursorCreatedAt, cursorId, limit]
          const cursorCreatedAt = new Date(String(params[1]));
          const cursorId = String(params[3]);
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
            if (v.hidden) return false;
            if (v.visibility === 'PRIVATE' && (!callerId || v.owner_id !== callerId)) return false;
            return true;
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
        return { rows: pl ? [pl] : [], rowCount: pl ? 1 : 0 };
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
