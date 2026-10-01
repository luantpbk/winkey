import createClient, { type ClientOptions, type Middleware } from 'openapi-fetch';
import type { paths as AuthPaths, components as AuthComponents } from './types/auth.js';
import type { paths as UploadPaths, components as UploadComponents } from './types/upload.js';
import type { paths as VideoPaths, components as VideoComponents } from './types/video.js';
import type { paths as SocialPaths, components as SocialComponents } from './types/social.js';
import type { paths as RealtimePaths } from './types/realtime.js';

// Export raw generated paths and components
export type { paths as AuthPaths, components as AuthComponents } from './types/auth.js';
export type { paths as UploadPaths, components as UploadComponents } from './types/upload.js';
export type { paths as VideoPaths, components as VideoComponents } from './types/video.js';
export type { paths as SocialPaths, components as SocialComponents } from './types/social.js';
export type { paths as RealtimePaths, components as RealtimeComponents } from './types/realtime.js';

// Convenient domain type shortcuts
export type User = AuthComponents['schemas']['User'];
export type PublicProfile = AuthComponents['schemas']['PublicProfile'];
export type Role = AuthComponents['schemas']['Role'];
export type TokenResponse = AuthComponents['schemas']['TokenResponse'];
export type RegisterRequest = AuthComponents['schemas']['RegisterRequest'];
export type LoginRequest = AuthComponents['schemas']['LoginRequest'];
export type UpdateMeRequest = AuthComponents['schemas']['UpdateMeRequest'];
export type ChangePasswordRequest = AuthComponents['schemas']['ChangePasswordRequest'];
export type DeleteMeRequest = AuthComponents['schemas']['DeleteMeRequest'];
export type PasswordResetRequest = AuthComponents['schemas']['PasswordResetRequest'];
export type ResetPasswordRequest = AuthComponents['schemas']['ResetPasswordRequest'];
export type VerifyEmailRequest = AuthComponents['schemas']['VerifyEmailRequest'];
export type Problem = AuthComponents['schemas']['Problem'];
export type ProblemError = NonNullable<Problem['errors']>[number];

export type CreateUploadRequest = UploadComponents['schemas']['CreateUploadRequest'];
export type CreateUploadResponse = UploadComponents['schemas']['CreateUploadResponse'];
export type PresignPartsRequest = UploadComponents['schemas']['PresignPartsRequest'];
export type PresignPartsResponse = UploadComponents['schemas']['PresignPartsResponse'];
export type CompleteUploadRequest = UploadComponents['schemas']['CompleteUploadRequest'];
export type UploadStatus = UploadComponents['schemas']['UploadStatus'];

export type Video = VideoComponents['schemas']['Video'];
export type VideoSummary = VideoComponents['schemas']['VideoSummary'];
export type VideoPage = VideoComponents['schemas']['VideoPage'];
export type StudioVideo = VideoComponents['schemas']['StudioVideo'];
export type StudioVideoPage = VideoComponents['schemas']['StudioVideoPage'];
export type UpdateVideoRequest = VideoComponents['schemas']['UpdateVideoRequest'];
export type Playback = VideoComponents['schemas']['Playback'];
export type Rendition = VideoComponents['schemas']['Rendition'];
export type SubtitleTrack = VideoComponents['schemas']['SubtitleTrack'];
export type PutSubtitleRequest = VideoComponents['schemas']['PutSubtitleRequest'];
export type PlaybackHeartbeatBatch = VideoComponents['schemas']['PlaybackHeartbeatBatch'];
export type PlaybackSample = VideoComponents['schemas']['PlaybackSample'];
export type PlaybackHeartbeatResult = VideoComponents['schemas']['PlaybackHeartbeatResult'];
export type VideoStatus = VideoComponents['schemas']['VideoStatus'];
export type Visibility = VideoComponents['schemas']['Visibility'];
export type VideoBatch = VideoComponents['schemas']['VideoBatch'];
export type StatsTotals = VideoComponents['schemas']['StatsTotals'];
export type VideoStatsDay = VideoComponents['schemas']['VideoStatsDay'];
export type VideoStats = VideoComponents['schemas']['VideoStats'];
export type ChannelStatsDay = VideoComponents['schemas']['ChannelStatsDay'];
export type ChannelStatsTopVideo = VideoComponents['schemas']['ChannelStatsTopVideo'];
export type ChannelStats = VideoComponents['schemas']['ChannelStats'];

export type Comment = SocialComponents['schemas']['Comment'];
export type CommentPage = SocialComponents['schemas']['CommentPage'];
export type CommentStatus = SocialComponents['schemas']['CommentStatus'];
export type CreateCommentRequest = SocialComponents['schemas']['CreateCommentRequest'];
export type EditCommentRequest = SocialComponents['schemas']['EditCommentRequest'];
export type LikeState = SocialComponents['schemas']['LikeState'];
export type SubscriptionState = SocialComponents['schemas']['SubscriptionState'];
export type Subscription = SocialComponents['schemas']['Subscription'];
export type SubscriptionPage = SocialComponents['schemas']['SubscriptionPage'];
export type NotificationKind = SocialComponents['schemas']['NotificationKind'];
export type Notification = SocialComponents['schemas']['Notification'];
export type NotificationPage = SocialComponents['schemas']['NotificationPage'];
export type UnreadCount = SocialComponents['schemas']['UnreadCount'];
export type MarkNotificationsReadRequest =
  SocialComponents['schemas']['MarkNotificationsReadRequest'];

export type PlaylistKind = SocialComponents['schemas']['PlaylistKind'];
export type Playlist = SocialComponents['schemas']['Playlist'];
export type PlaylistPage = SocialComponents['schemas']['PlaylistPage'];
export type CreatePlaylistRequest = SocialComponents['schemas']['CreatePlaylistRequest'];
export type UpdatePlaylistRequest = SocialComponents['schemas']['UpdatePlaylistRequest'];
export type PlaylistItem = SocialComponents['schemas']['PlaylistItem'];
export type PlaylistItemPage = SocialComponents['schemas']['PlaylistItemPage'];
export type AddPlaylistItemRequest = SocialComponents['schemas']['AddPlaylistItemRequest'];
export type MovePlaylistItemRequest = SocialComponents['schemas']['MovePlaylistItemRequest'];
export type PlaylistMembership = SocialComponents['schemas']['PlaylistMembership'];

export type AdminUser = AuthComponents['schemas']['AdminUser'];
export type AdminUserPage = AuthComponents['schemas']['AdminUserPage'];
export type UserStatus = AuthComponents['schemas']['UserStatus'];
export type SetRolesRequest = AuthComponents['schemas']['SetRolesRequest'];
export type SuspendUserRequest = AuthComponents['schemas']['SuspendUserRequest'];
export type AuditEntry = AuthComponents['schemas']['AuditEntry'];
export type AuditEntryPage = AuthComponents['schemas']['AuditEntryPage'];

export type ReportTargetType = SocialComponents['schemas']['ReportTargetType'];
export type ReportReason = SocialComponents['schemas']['ReportReason'];
export type ReportStatus = SocialComponents['schemas']['ReportStatus'];
export type CreateReportRequest = SocialComponents['schemas']['CreateReportRequest'];
export type ReportReceipt = SocialComponents['schemas']['ReportReceipt'];
export type Report = SocialComponents['schemas']['Report'];
export type ModerationCase = SocialComponents['schemas']['ModerationCase'];
export type ModerationCasePage = SocialComponents['schemas']['ModerationCasePage'];
export type ResolveCaseRequest = SocialComponents['schemas']['ResolveCaseRequest'];
export type ResolveCaseResult = SocialComponents['schemas']['ResolveCaseResult'];
export type ModerateCommentRequest = SocialComponents['schemas']['ModerateCommentRequest'];

export type ModerateVideoRequest = VideoComponents['schemas']['ModerateVideoRequest'];
export type VideoModeration = VideoComponents['schemas']['VideoModeration'];

export interface WinkeyClientOptions extends Omit<ClientOptions, 'baseUrl'> {
  baseUrl?: string;
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
}

export function createAuthInterceptor(
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>,
): Middleware {
  return {
    async onRequest({ request }) {
      const token = await getAccessToken();
      if (token && !request.headers.has('Authorization')) {
        request.headers.set('Authorization', `Bearer ${token}`);
      }
      return request;
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
export type UploadClient = ReturnType<typeof createUploadClient>;
export type VideoClient = ReturnType<typeof createVideoClient>;
export type SocialClient = ReturnType<typeof createSocialClient>;
export type RealtimeClient = ReturnType<typeof createRealtimeClient>;

export function createAuthClient(options: WinkeyClientOptions = {}) {
  const { baseUrl = '', getAccessToken, ...clientOptions } = options;
  const client = createClient<AuthPaths>({ baseUrl, ...clientOptions });
  if (getAccessToken) {
    client.use(createAuthInterceptor(getAccessToken));
  }
  return client;
}

export function createUploadClient(options: WinkeyClientOptions = {}) {
  const { baseUrl = '', getAccessToken, ...clientOptions } = options;
  const client = createClient<UploadPaths>({ baseUrl, ...clientOptions });
  if (getAccessToken) {
    client.use(createAuthInterceptor(getAccessToken));
  }
  return client;
}

export function createVideoClient(options: WinkeyClientOptions = {}) {
  const { baseUrl = '', getAccessToken, ...clientOptions } = options;
  const client = createClient<VideoPaths>({ baseUrl, ...clientOptions });
  if (getAccessToken) {
    client.use(createAuthInterceptor(getAccessToken));
  }
  return client;
}

export function createSocialClient(options: WinkeyClientOptions = {}) {
  const { baseUrl = '', getAccessToken, ...clientOptions } = options;
  const client = createClient<SocialPaths>({ baseUrl, ...clientOptions });
  if (getAccessToken) {
    client.use(createAuthInterceptor(getAccessToken));
  }
  return client;
}

export function createRealtimeClient(options: WinkeyClientOptions = {}) {
  const { baseUrl = '', getAccessToken, ...clientOptions } = options;
  const client = createClient<RealtimePaths>({ baseUrl, ...clientOptions });
  if (getAccessToken) {
    client.use(createAuthInterceptor(getAccessToken));
  }
  return client;
}

export function createWinkeyClient(options: WinkeyClientOptions = {}) {
  return {
    auth: createAuthClient(options),
    upload: createUploadClient(options),
    video: createVideoClient(options),
    social: createSocialClient(options),
    realtime: createRealtimeClient(options),
  };
}
