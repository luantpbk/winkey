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

export type ReportTargetType = 'VIDEO' | 'COMMENT' | 'USER' | 'POST' | 'POST_COMMENT';
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
  bio?: string | null;
  links?: unknown;
  banner_key?: string | null;
  is_private?: boolean;
  created_at?: Generated<Date>;
}

export interface FollowRequestsTable {
  requester_id: string;
  target_id: string;
  created_at: Generated<Date>;
}

export interface BlocksTable {
  blocker_id: string;
  blocked_id: string;
  created_at: Generated<Date>;
}

export interface MutesTable {
  muter_id: string;
  muted_id: string;
  created_at: Generated<Date>;
}

export type NotificationKind =
  | 'VIDEO_PUBLISHED'
  | 'VIDEO_COMMENT'
  | 'COMMENT_REPLY'
  | 'NEW_SUBSCRIBER'
  | 'FOLLOW_REQUEST'
  | 'FOLLOW_REQUEST_APPROVED'
  | 'POST_COMMENT'
  | 'POST_COMMENT_REPLY'
  | 'POST_MENTION'
  | 'POST_RESHARE'
  | 'POST_REACTION';

export interface NotificationsTable {
  id: string;
  user_id: string;
  kind: NotificationKind;
  actor_id: string;
  video_id: string | null;
  comment_id: string | null;
  post_id: string | null;
  post_comment_id: string | null;
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

export type PostVisibility = 'PUBLIC' | 'FOLLOWERS';
export type PostStatus = 'VISIBLE' | 'DELETED' | 'HIDDEN';
export type ReactionKind = 'LIKE' | 'LOVE' | 'HAHA' | 'WOW' | 'SAD' | 'ANGRY';

export interface PostsTable {
  id: string;
  author_id: string;
  body: string;
  visibility: Generated<PostVisibility>;
  status: Generated<PostStatus>;
  video_id: string | null;
  reshare_of: string | null;
  media_count: Generated<number>;
  reaction_count: Generated<string | number>;
  comment_count: Generated<string | number>;
  reshare_count: Generated<string | number>;
  edited_at: Date | string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PostMediaTable {
  post_id: string;
  position: number;
  image_id: string;
  image_key: string;
  thumb_key: string;
  width: number;
  height: number;
}

export interface PostReactionsTable {
  post_id: string;
  user_id: string;
  reaction: ReactionKind;
  created_at: Generated<Date>;
}

export interface PostCommentsTable {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  body: string;
  status: Generated<CommentStatus>;
  reply_count: Generated<number>;
  edited_at: Date | string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PostHashtagsTable {
  post_id: string;
  tag: string;
  slug: Generated<string>;
  created_at: Date;
}

export interface PostMentionsTable {
  post_id: string;
  user_id: string;
}

export interface PostScoresTable {
  post_id: string;
  score: number;
  computed_at: Generated<Date>;
}

export interface ReadyImagesTable {
  id: string;
  owner_id: string;
  image_key: string;
  thumb_key: string;
  width: number;
  height: number;
  purpose: string;
}

export interface Database {
  'social.videos': VideosTable;
  'social.comments': CommentsTable;
  'social.video_likes': VideoLikesTable;
  'social.channels': ChannelsTable;
  'social.subscriptions': SubscriptionsTable;
  'social.follow_requests': FollowRequestsTable;
  'social.blocks': BlocksTable;
  'social.mutes': MutesTable;
  'social.reports': ReportsTable;
  'social.notifications': NotificationsTable;
  'social.playlists': PlaylistsTable;
  'social.playlist_items': PlaylistItemsTable;
  'social.posts': PostsTable;
  'social.post_media': PostMediaTable;
  'social.post_reactions': PostReactionsTable;
  'social.post_comments': PostCommentsTable;
  'social.post_hashtags': PostHashtagsTable;
  'social.post_mentions': PostMentionsTable;
  'social.post_scores': PostScoresTable;
  'social.outbox': OutboxTable;
  'auth.public_profiles': PublicProfilesTable;
  'media.ready_images': ReadyImagesTable;
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
  requested?: boolean;
  subscriber_count: number;
}

export interface FollowItemDto {
  user: PublicProfileDto;
  followed_at: string;
}

export interface FollowPageDto {
  items: FollowItemDto[];
  next_cursor: string | null;
}

export interface FollowRequestDto {
  requester: PublicProfileDto;
  requested_at: string;
}

export interface FollowRequestPageDto {
  items: FollowRequestDto[];
  next_cursor: string | null;
  pending_count: number;
}

export interface FollowRequestDecisionDto {
  decision: 'APPROVE' | 'REJECT';
}

export interface RelationshipDto {
  user_id: string;
  following: boolean;
  follow_requested: boolean;
  followed_by: boolean;
  blocking: boolean;
  muting: boolean;
}

export interface RelationItemDto {
  user: PublicProfileDto;
  since: string;
}

export interface RelationPageDto {
  items: RelationItemDto[];
  next_cursor: string | null;
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
  post_id: string | null;
  post_comment_id: string | null;
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

export interface SeriesForVideoDto {
  items: SeriesSummaryDto[];
}

export interface PostImageDto {
  id: string;
  url: string;
  thumb_url: string;
  width: number;
  height: number;
}

export interface PostMentionDto {
  user_id: string;
  handle: string;
}

export interface PostHashtagDto {
  tag: string;
  slug: string;
}

export interface ReactionCountDto {
  reaction: ReactionKind;
  count: number;
}

export interface PostDto {
  id: string;
  author: PublicProfileDto | null;
  body: string;
  visibility: PostVisibility;
  status: PostStatus;
  images: PostImageDto[];
  video_id: string | null;
  reshare_of: string | null;
  reshared_post: PostDto | null;
  reshare_unavailable: boolean;
  mentions: PostMentionDto[];
  hashtags: PostHashtagDto[];
  reaction_count: number;
  top_reactions: ReactionCountDto[];
  my_reaction: ReactionKind | null;
  comment_count: number;
  reshare_count: number;
  created_at: string;
  edited_at: string | null;
  can_edit: boolean;
  can_delete: boolean;
}

export interface PostPageDto {
  items: PostDto[];
  next_cursor: string | null;
}

export interface ReactionStateDto {
  post_id: string;
  my_reaction: ReactionKind | null;
  reaction_count: number;
  top_reactions: ReactionCountDto[];
}

export interface ReactionItemDto {
  user: PublicProfileDto;
  reaction: ReactionKind;
  created_at: string;
}

export interface ReactionPageDto {
  items: ReactionItemDto[];
  next_cursor: string | null;
}

export interface PostCommentDto {
  id: string;
  post_id: string;
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

export interface PostCommentPageDto {
  items: PostCommentDto[];
  next_cursor: string | null;
}

export interface TrendingHashtagDto {
  tag: string;
  slug: string;
  post_count: number;
}

export interface TrendingHashtagsDto {
  items: TrendingHashtagDto[];
}
