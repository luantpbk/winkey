import type { Generated } from 'kysely';

export type CommentStatus = 'VISIBLE' | 'DELETED' | 'HIDDEN';

export interface VideosTable {
  id: string;
  owner_id: string;
  like_count: Generated<string | number>;
  comment_count: Generated<string | number>;
  created_at: Generated<Date>;
}

export interface CommentsTable {
  id: string;
  video_id: string;
  author_id: string;
  parent_id: string | null;
  body: string;
  status: Generated<CommentStatus>;
  reply_count: Generated<number>;
  edited_at: Date | string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VideoLikesTable {
  video_id: string;
  user_id: string;
  created_at: Generated<Date>;
}

export interface ChannelsTable {
  id: string;
  subscriber_count: Generated<string | number>;
}

export interface SubscriptionsTable {
  subscriber_id: string;
  channel_id: string;
  created_at: Generated<Date>;
}

export interface OutboxTable {
  id: Generated<string | number>;
  event_id: string;
  subject: string;
  payload: unknown;
  created_at: Generated<Date>;
  published_at: Date | string | null;
}

export interface PublicProfilesTable {
  id: string;
  handle: string;
  display_name: string;
  avatar_key: string | null;
}

export interface Database {
  'social.videos': VideosTable;
  'social.comments': CommentsTable;
  'social.video_likes': VideoLikesTable;
  'social.channels': ChannelsTable;
  'social.subscriptions': SubscriptionsTable;
  'social.outbox': OutboxTable;
  'auth.public_profiles': PublicProfilesTable;
}

export interface PublicProfileDto {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

export interface CommentDto {
  id: string;
  video_id: string;
  parent_id: string | null;
  author: PublicProfileDto | null;
  body: string;
  status: CommentStatus;
  reply_count: number;
  created_at: string;
  edited_at: string | null;
  can_edit: boolean;
  can_delete: boolean;
}

export interface CommentPageDto {
  items: CommentDto[];
  next_cursor: string | null;
}

export interface LikeStateDto {
  video_id: string;
  liked: boolean;
  like_count: number;
}

export interface SubscriptionStateDto {
  channel_id: string;
  subscribed: boolean;
  subscriber_count: number;
}

export interface SubscriptionItemDto {
  channel: PublicProfileDto;
  subscribed_at: string;
}

export interface SubscriptionPageDto {
  items: SubscriptionItemDto[];
  next_cursor: string | null;
}
