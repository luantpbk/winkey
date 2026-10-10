import type { Generated } from 'kysely';

export type CommentStatus = 'VISIBLE' | 'DELETED' | 'HIDDEN';
export type VideoVisibility = 'PUBLIC' | 'UNLISTED' | 'PRIVATE';

export interface VideosTable {
  id: string;
  owner_id: string;
  like_count: Generated<string | number>;
  comment_count: Generated<string | number>;
  hidden: Generated<boolean>;
  visibility: Generated<VideoVisibility>;
  created_at: Generated<Date>;
}

export type ReportTargetType = 'VIDEO' | 'COMMENT' | 'USER';
export type ReportReason =
  'SPAM' | 'HARASSMENT' | 'HATE' | 'SEXUAL' | 'VIOLENCE' | 'COPYRIGHT' | 'MISINFORMATION' | 'OTHER';
export type ReportStatus = 'OPEN' | 'ACTIONED' | 'DISMISSED';

export interface ReportsTable {
  id: string;
  reporter_id: string;
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  note: Generated<string>;
  status: Generated<ReportStatus>;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_at: Date | string | null;
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

export type NotificationKind =
  'VIDEO_PUBLISHED' | 'VIDEO_COMMENT' | 'COMMENT_REPLY' | 'NEW_SUBSCRIBER';

export interface NotificationsTable {
  id: string;
  user_id: string;
  kind: NotificationKind;
  actor_id: string;
  video_id: string | null;
  comment_id: string | null;
  created_at: Generated<Date>;
  read_at: Date | string | null;
}

export type PlaylistKind = 'REGULAR' | 'WATCH_LATER';
export type PlaylistVisibility = 'PUBLIC' | 'UNLISTED' | 'PRIVATE';

export interface PlaylistsTable {
  id: string;
  owner_id: string;
  kind: Generated<PlaylistKind>;
  title: string;
  description: Generated<string>;
  visibility: Generated<PlaylistVisibility>;
  is_series: Generated<boolean>;
  item_count: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PlaylistItemsTable {
  playlist_id: string;
  video_id: string;
  position: string | number;
  added_at: Generated<Date>;
}

export interface Database {
  'social.videos': VideosTable;
  'social.comments': CommentsTable;
  'social.video_likes': VideoLikesTable;
  'social.channels': ChannelsTable;
  'social.subscriptions': SubscriptionsTable;
  'social.reports': ReportsTable;
  'social.notifications': NotificationsTable;
  'social.playlists': PlaylistsTable;
  'social.playlist_items': PlaylistItemsTable;
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

export interface ReportReceiptDto {
  id: string;
  created_at: string;
}

export interface ReportDto {
  id: string;
  reporter: PublicProfileDto | null;
  reason: ReportReason;
  note: string;
  status: ReportStatus;
  created_at: string;
}

export interface ModerationCaseDto {
  target_type: ReportTargetType;
  target_id: string;
  status: ReportStatus;
  open_count: number;
  first_reported_at: string;
  reasons: Record<string, number>;
  reports: ReportDto[];
  resolution: {
    resolved_by: string;
    note: string | null;
    resolved_at: string;
  } | null;
}

export interface ModerationCasePageDto {
  items: ModerationCaseDto[];
  next_cursor: string | null;
}

export interface ResolveCaseResultDto {
  resolved_count: number;
}

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  actor: PublicProfileDto;
  video_id: string | null;
  comment_id: string | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationPageDto {
  items: NotificationDto[];
  next_cursor: string | null;
}

export interface UnreadCountDto {
  count: number;
  capped: boolean;
}

export interface MarkNotificationsReadRequestDto {
  ids?: string[];
  up_to?: string;
}

export interface PlaylistDto {
  id: string;
  owner: PublicProfileDto;
  kind: PlaylistKind;
  title: string;
  description: string;
  visibility: PlaylistVisibility;
  is_series: boolean;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlaylistPageDto {
  items: PlaylistDto[];
  next_cursor: string | null;
}

export interface PlaylistItemDto {
  video_id: string;
  position: number;
  added_at: string;
}

export interface PlaylistItemPageDto {
  items: PlaylistItemDto[];
  next_cursor: string | null;
}

export interface PlaylistMembershipDto {
  playlist_ids: string[];
}

export interface SeriesSummaryDto {
  playlist_id: string;
  title: string;
  description: string;
  owner: PublicProfileDto;
  episode_count: number;
  first_video_id: string;
  updated_at: string;
}

export interface CinemaCatalogSeriesDto {
  kind: 'SERIES';
  series: SeriesSummaryDto;
}

export interface CinemaCatalogVideoDto {
  kind: 'VIDEO';
  video_id: string;
  added_at: string;
}

export type CinemaCatalogItemDto = CinemaCatalogSeriesDto | CinemaCatalogVideoDto;

export interface CinemaCatalogPageDto {
  items: CinemaCatalogItemDto[];
  next_cursor: string | null;
}

export interface SeriesEpisodeDto {
  video_id: string;
  episode_number: number;
}

export interface SeriesEpisodePageDto {
  series: SeriesSummaryDto;
  items: SeriesEpisodeDto[];
  next_cursor: string | null;
}

export interface SeriesEpisodeContextDto {
  series: SeriesSummaryDto;
  episode_number: number;
  previous_video_id: string | null;
  next_video_id: string | null;
  page_cursor: string | null;
}
