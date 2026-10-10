import type {
  User,
  PublicProfile,
  Video,
  StudioVideo,
  AdminUser,
  ModerationCase,
  AuditEntry,
  Playlist,
  SeriesSummary,
  SeriesEpisode,
  CinemaCatalogItem,
} from '@winkey/api-client';

export const mockUsers: Record<string, User> = {
  creator: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
    email: 'creator@winkey.vn',
    email_verified: true,
    handle: 'winkey_creator',
    display_name: 'Winkey Official Creator',
    avatar_url:
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
    roles: ['viewer', 'creator'],
    has_password: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  tech_guy: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
    email: 'tech@winkey.vn',
    email_verified: true,
    handle: 'viet_coder',
    display_name: 'Việt Coder Channel',
    avatar_url:
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&auto=format&fit=crop&q=80',
    roles: ['viewer', 'creator'],
    has_password: true,
    created_at: '2026-01-15T00:00:00Z',
  },
  admin: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03',
    email: 'admin@winkey.vn',
    email_verified: true,
    handle: 'admin_winkey',
    display_name: 'Winkey Administrator',
    avatar_url:
      'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80',
    roles: ['viewer', 'admin'],
    has_password: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  moderator: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c04',
    email: 'mod@winkey.vn',
    email_verified: true,
    handle: 'mod_winkey',
    display_name: 'Winkey Moderator',
    avatar_url:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&auto=format&fit=crop&q=80',
    roles: ['viewer', 'moderator'],
    has_password: true,
    created_at: '2026-01-05T00:00:00Z',
  },
  plain_viewer: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c05',
    email: 'viewer@winkey.vn',
    email_verified: true,
    handle: 'simple_viewer',
    display_name: 'Simple Viewer',
    avatar_url: null,
    roles: ['viewer'],
    has_password: true,
    created_at: '2026-02-01T00:00:00Z',
  },
  spammer: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c06',
    email: 'spammer@winkey.vn',
    email_verified: false,
    handle: 'spammer_bot',
    display_name: 'Spammer Bot',
    avatar_url: null,
    roles: ['viewer'],
    has_password: true,
    created_at: '2026-03-01T00:00:00Z',
  },
  google_user: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c08',
    email: 'google_user@winkey.vn',
    email_verified: true,
    handle: 'google_user',
    display_name: 'Google OAuth User',
    avatar_url: null,
    roles: ['viewer'],
    has_password: false,
    created_at: '2026-03-01T00:00:00Z',
  },
};

export const mockPublicProfiles: Record<string, PublicProfile> = {
  winkey_creator: {
    id: mockUsers.creator.id,
    handle: mockUsers.creator.handle,
    display_name: mockUsers.creator.display_name,
    avatar_url: mockUsers.creator.avatar_url,
  },
  viet_coder: {
    id: mockUsers.tech_guy.id,
    handle: mockUsers.tech_guy.handle,
    display_name: mockUsers.tech_guy.display_name,
    avatar_url: mockUsers.tech_guy.avatar_url,
  },
  admin_winkey: {
    id: mockUsers.admin.id,
    handle: mockUsers.admin.handle,
    display_name: mockUsers.admin.display_name,
    avatar_url: mockUsers.admin.avatar_url,
  },
  mod_winkey: {
    id: mockUsers.moderator.id,
    handle: mockUsers.moderator.handle,
    display_name: mockUsers.moderator.display_name,
    avatar_url: mockUsers.moderator.avatar_url,
  },
};

export const mockVideos: Video[] = [
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    title: 'Xây dựng kiến trúc hệ thống Video Streaming phân tán kiểu YouTube với Go & k3s',
    description:
      'Trong video này, chúng ta sẽ tìm hiểu kiến trúc microservices phân tán phục vụ hàng triệu người xem với Garage S3, NATS JetStream và HLS CMAF transcoding.',
    owner: mockPublicProfiles.winkey_creator,
    visibility: 'PUBLIC',
    status: 'READY',
    duration_ms: 1245000, // 20m 45s
    width: 1920,
    height: 1080,
    view_count: 142500,
    like_count: 8940,
    published_at: '2026-09-15T10:00:00Z',
    created_at: '2026-09-15T08:30:00Z',
    playback: {
      hls_url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      thumbnail_url:
        'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80',
      renditions: [
        { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 },
        { name: '720p', width: 1280, height: 720, bitrate_kbps: 2800 },
        { name: '480p', width: 854, height: 480, bitrate_kbps: 1400 },
      ],
      subtitles: [
        {
          lang: 'vi',
          label: 'Tiếng Việt',
          source: 'UPLOAD',
          url: '/v1/mock-subtitles/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10/vi.vtt',
          updated_at: '2026-09-15T10:00:00Z',
        },
        {
          lang: 'en',
          label: 'English',
          source: 'UPLOAD',
          url: '/v1/mock-subtitles/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10/en.vtt',
          updated_at: '2026-09-15T10:00:00Z',
        },
      ],
      storyboard_url: '/v1/mock-storyboard/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10/storyboard.vtt',
    },
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11',
    title: 'Lập trình Next.js 15 App Router và Tailwind CSS v4 chuyên sâu từ A đến Z',
    description:
      'Hướng dẫn đầy đủ về Server Components, Streaming SSR, Mock Service Worker và tối ưu hóa Lighthouse 100/100.',
    owner: mockPublicProfiles.viet_coder,
    visibility: 'PUBLIC',
    status: 'READY',
    duration_ms: 875000, // 14m 35s
    width: 1920,
    height: 1080,
    view_count: 85200,
    like_count: 6300,
    published_at: '2026-09-20T14:30:00Z',
    created_at: '2026-09-20T13:00:00Z',
    playback: {
      hls_url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      thumbnail_url:
        'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800&auto=format&fit=crop&q=80',
      renditions: [
        { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 },
        { name: '720p', width: 1280, height: 720, bitrate_kbps: 2800 },
      ],
    },
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12',
    title: 'Khám phá phần cứng GPU RTX 5060 Ti chạy FFmpeg NVENC 4K',
    description:
      'Đánh giá tốc độ mã hóa video phần cứng trên thế hệ GPU Blackwell và cấu hình tham số tối ưu cho chất lượng HLS streaming.',
    owner: mockPublicProfiles.winkey_creator,
    visibility: 'PUBLIC',
    status: 'READY',
    duration_ms: 612000, // 10m 12s
    width: 1920,
    height: 1080,
    view_count: 42100,
    like_count: 3200,
    published_at: '2026-09-22T08:00:00Z',
    created_at: '2026-09-22T06:00:00Z',
    playback: {
      hls_url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      thumbnail_url:
        'https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?w=800&auto=format&fit=crop&q=80',
      renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 }],
    },
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c13',
    title: 'Tối ưu hóa Database PostgreSQL với 100 Triệu Rows',
    description:
      'Chiến lược indexing, partitioning và tối ưu hóa query execution plan trong PostgreSQL 17.',
    owner: mockPublicProfiles.viet_coder,
    visibility: 'PUBLIC',
    status: 'READY',
    duration_ms: 1530000, // 25m 30s
    width: 1920,
    height: 1080,
    view_count: 98000,
    like_count: 7400,
    published_at: '2026-09-24T16:00:00Z',
    created_at: '2026-09-24T15:00:00Z',
    playback: {
      hls_url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      thumbnail_url:
        'https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=800&auto=format&fit=crop&q=80',
      renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 }],
    },
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c14',
    title: 'Video bị vi phạm bản quyền',
    description: 'Video này đã bị ẩn bởi người điều hành.',
    owner: mockPublicProfiles.winkey_creator,
    visibility: 'PUBLIC',
    status: 'READY',
    duration_ms: 300000,
    width: 1920,
    height: 1080,
    view_count: 500,
    like_count: 10,
    published_at: '2026-09-26T10:00:00Z',
    created_at: '2026-09-26T09:00:00Z',
    playback: null,
    moderation: {
      state: 'HIDDEN',
      reason: 'Vi phạm bản quyền video âm nhạc',
      moderated_at: '2026-09-28T10:00:00Z',
    },
  },
];

export const mockStudioVideos: StudioVideo[] = [
  {
    id: mockVideos[0].id,
    title: mockVideos[0].title,
    visibility: mockVideos[0].visibility,
    status: mockVideos[0].status,
    progress: 100,
    error: null,
    duration_ms: mockVideos[0].duration_ms,
    created_at: mockVideos[0].created_at,
    thumbnail_url: mockVideos[0].playback?.thumbnail_url || null,
  },
  {
    id: mockVideos[2].id,
    title: mockVideos[2].title,
    visibility: mockVideos[2].visibility,
    status: mockVideos[2].status,
    progress: 100,
    error: null,
    duration_ms: mockVideos[2].duration_ms,
    created_at: mockVideos[2].created_at,
    thumbnail_url: mockVideos[2].playback?.thumbnail_url || null,
  },
  {
    id: mockVideos[4].id,
    title: mockVideos[4].title,
    visibility: mockVideos[4].visibility,
    status: mockVideos[4].status,
    progress: 100,
    error: null,
    duration_ms: mockVideos[4].duration_ms,
    created_at: mockVideos[4].created_at,
    thumbnail_url: null,
    moderation: {
      state: 'HIDDEN',
      reason: 'Vi phạm bản quyền video âm nhạc',
      moderated_at: '2026-09-28T10:00:00Z',
    },
  },
  {
    id: '018f3a22-7f91-7d9a-9e12-000000000099',
    title: 'Realtime E2E Processing Video',
    visibility: 'PUBLIC',
    status: 'PROCESSING',
    progress: 15,
    error: null,
    duration_ms: 60000,
    created_at: '2026-09-25T10:00:00Z',
    thumbnail_url: null,
  },
];

export const mockAdminUsers: AdminUser[] = [
  {
    id: mockUsers.creator.id,
    email: mockUsers.creator.email,
    email_verified: true,
    handle: mockUsers.creator.handle,
    display_name: mockUsers.creator.display_name,
    avatar_url: mockUsers.creator.avatar_url,
    roles: ['viewer', 'creator'],
    status: 'ACTIVE',
    suspension_reason: null,
    suspended_until: null,
    created_at: mockUsers.creator.created_at,
  },
  {
    id: mockUsers.tech_guy.id,
    email: mockUsers.tech_guy.email,
    email_verified: true,
    handle: mockUsers.tech_guy.handle,
    display_name: mockUsers.tech_guy.display_name,
    avatar_url: mockUsers.tech_guy.avatar_url,
    roles: ['viewer', 'creator'],
    status: 'ACTIVE',
    suspension_reason: null,
    suspended_until: null,
    created_at: mockUsers.tech_guy.created_at,
  },
  {
    id: mockUsers.admin.id,
    email: mockUsers.admin.email,
    email_verified: true,
    handle: mockUsers.admin.handle,
    display_name: mockUsers.admin.display_name,
    avatar_url: mockUsers.admin.avatar_url,
    roles: ['viewer', 'admin'],
    status: 'ACTIVE',
    suspension_reason: null,
    suspended_until: null,
    created_at: mockUsers.admin.created_at,
  },
  {
    id: mockUsers.moderator.id,
    email: mockUsers.moderator.email,
    email_verified: true,
    handle: mockUsers.moderator.handle,
    display_name: mockUsers.moderator.display_name,
    avatar_url: mockUsers.moderator.avatar_url,
    roles: ['viewer', 'moderator'],
    status: 'ACTIVE',
    suspension_reason: null,
    suspended_until: null,
    created_at: mockUsers.moderator.created_at,
  },
  {
    id: mockUsers.plain_viewer.id,
    email: mockUsers.plain_viewer.email,
    email_verified: true,
    handle: mockUsers.plain_viewer.handle,
    display_name: mockUsers.plain_viewer.display_name,
    avatar_url: mockUsers.plain_viewer.avatar_url,
    roles: ['viewer'],
    status: 'ACTIVE',
    suspension_reason: null,
    suspended_until: null,
    created_at: mockUsers.plain_viewer.created_at,
  },
  {
    id: mockUsers.spammer.id,
    email: mockUsers.spammer.email,
    email_verified: false,
    handle: mockUsers.spammer.handle,
    display_name: mockUsers.spammer.display_name,
    avatar_url: mockUsers.spammer.avatar_url,
    roles: ['viewer'],
    status: 'SUSPENDED',
    suspension_reason: 'Spamming links and phishing content',
    suspended_until: '2026-10-30T00:00:00Z',
    created_at: mockUsers.spammer.created_at,
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c07',
    email: 'deleted@winkey.vn',
    email_verified: false,
    handle: 'deleted_user',
    display_name: 'Deleted Account',
    avatar_url: null,
    roles: ['viewer'],
    status: 'DELETED',
    suspension_reason: null,
    suspended_until: null,
    created_at: '2026-01-01T00:00:00Z',
  },
];

export const mockModerationCases: ModerationCase[] = [
  {
    target_type: 'VIDEO',
    target_id: mockVideos[0].id,
    status: 'OPEN',
    open_count: 2,
    first_reported_at: '2026-09-28T08:00:00Z',
    reasons: {
      SPAM: 1,
      COPYRIGHT: 1,
    },
    reports: [
      {
        id: '0192f5e4-7c1a-7b3e-9d2a-r00000000001',
        reporter: mockPublicProfiles.viet_coder,
        reason: 'COPYRIGHT',
        note: 'Có chứa nhạc bản quyền không xin phép.',
        status: 'OPEN',
        created_at: '2026-09-28T08:30:00Z',
      },
      {
        id: '0192f5e4-7c1a-7b3e-9d2a-r00000000002',
        reporter: mockPublicProfiles.winkey_creator,
        reason: 'SPAM',
        note: 'Quảng cáo sai sự thật.',
        status: 'OPEN',
        created_at: '2026-09-28T08:00:00Z',
      },
    ],
    resolution: null,
  },
  {
    target_type: 'COMMENT',
    target_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
    status: 'OPEN',
    open_count: 1,
    first_reported_at: '2026-09-29T10:00:00Z',
    reasons: {
      HARASSMENT: 1,
    },
    reports: [
      {
        id: '0192f5e4-7c1a-7b3e-9d2a-r00000000003',
        reporter: mockPublicProfiles.viet_coder,
        reason: 'HARASSMENT',
        note: 'Ngôn từ xúc phạm người khác.',
        status: 'OPEN',
        created_at: '2026-09-29T10:00:00Z',
      },
    ],
    resolution: null,
  },
];

export const mockAuditEntries: AuditEntry[] = [
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-a00000000001',
    actor: mockPublicProfiles.admin_winkey,
    action: 'USER_ROLES_CHANGED',
    target_user_id: mockUsers.moderator.id,
    details: {
      from: ['viewer'],
      to: ['viewer', 'moderator'],
    },
    created_at: '2026-09-28T14:00:00Z',
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-a00000000002',
    actor: mockPublicProfiles.admin_winkey,
    action: 'USER_SUSPENDED',
    target_user_id: mockUsers.spammer.id,
    details: {
      reason: 'Spamming links and phishing content',
      until: '2026-10-30T00:00:00Z',
    },
    created_at: '2026-09-28T15:30:00Z',
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-a00000000003',
    actor: mockPublicProfiles.admin_winkey,
    action: 'USER_UNSUSPENDED',
    target_user_id: mockUsers.plain_viewer.id,
    details: {},
    created_at: '2026-09-29T09:15:00Z',
  },
];

export const mockSeriesPlaylist: Playlist = {
  id: '0192f5e4-7c1a-7b3e-9d2a-p0000series01',
  owner: mockPublicProfiles.winkey_creator,
  kind: 'REGULAR',
  title: 'Hành Trình Kiến Trúc Hệ Thống (Phim bộ)',
  description: 'Series bài giảng kỹ thuật chuyên sâu về Distributed Video Streaming Platform.',
  visibility: 'PUBLIC',
  is_series: true,
  item_count: 3,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-25T12:00:00Z',
};

export const mockSeriesEpisodes: SeriesEpisode[] = [
  {
    video_id: mockVideos[0].id, // '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10'
    episode_number: 1,
  },
  {
    video_id: mockVideos[2].id, // '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12'
    episode_number: 2,
  },
  {
    video_id: mockVideos[1].id, // '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11'
    episode_number: 3,
  },
];

export const mockSeriesSummary: SeriesSummary = {
  playlist_id: mockSeriesPlaylist.id,
  title: mockSeriesPlaylist.title,
  description: mockSeriesPlaylist.description,
  owner: mockSeriesPlaylist.owner,
  episode_count: 3,
  first_video_id: mockSeriesEpisodes[0].video_id,
  updated_at: mockSeriesPlaylist.updated_at,
};

export const mockCinemaCatalogItems: CinemaCatalogItem[] = [
  {
    kind: 'SERIES',
    series: mockSeriesSummary,
  },
  {
    kind: 'VIDEO',
    video_id: mockVideos[3].id, // '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c13'
    added_at: '2026-09-24T16:00:00Z',
  },
];
