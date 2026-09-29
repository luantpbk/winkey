import type {
  User,
  PublicProfile,
  Video,
  StudioVideo,
} from '@winkey/api-client';

export const mockUsers: Record<string, User> = {
  creator: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
    email: 'creator@winkey.vn',
    email_verified: true,
    handle: 'winkey_creator',
    display_name: 'Winkey Official Creator',
    avatar_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
    roles: ['viewer', 'creator'],
    created_at: '2026-01-01T00:00:00Z',
  },
  tech_guy: {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
    email: 'tech@winkey.vn',
    email_verified: true,
    handle: 'viet_coder',
    display_name: 'Việt Coder Channel',
    avatar_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&auto=format&fit=crop&q=80',
    roles: ['viewer', 'creator'],
    created_at: '2026-01-15T00:00:00Z',
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
};

export const mockVideos: Video[] = [
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    title: 'Xây dựng kiến trúc hệ thống Video Streaming phân tán kiểu YouTube với Go & k3s',
    description: 'Trong video này, chúng ta sẽ tìm hiểu kiến trúc microservices phân tán phục vụ hàng triệu người xem với Garage S3, NATS JetStream và HLS CMAF transcoding.',
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
      thumbnail_url: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80',
      renditions: [
        { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 },
        { name: '720p', width: 1280, height: 720, bitrate_kbps: 2800 },
        { name: '480p', width: 854, height: 480, bitrate_kbps: 1400 },
      ],
    },
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11',
    title: 'Lập trình Next.js 15 App Router và Tailwind CSS v4 chuyên sâu từ A đến Z',
    description: 'Hướng dẫn đầy đủ về Server Components, Streaming SSR, Mock Service Worker và tối ưu hóa Lighthouse 100/100.',
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
      thumbnail_url: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800&auto=format&fit=crop&q=80',
      renditions: [
        { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 },
        { name: '720p', width: 1280, height: 720, bitrate_kbps: 2800 },
      ],
    },
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12',
    title: 'Khám phá phần cứng GPU RTX 5060 Ti chạy FFmpeg NVENC 4K',
    description: 'Đánh giá tốc độ mã hóa video phần cứng trên thế hệ GPU Blackwell và cấu hình tham số tối ưu cho chất lượng HLS streaming.',
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
      thumbnail_url: 'https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?w=800&auto=format&fit=crop&q=80',
      renditions: [
        { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 },
      ],
    },
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c13',
    title: 'Tối ưu hóa Database PostgreSQL với 100 Triệu Rows',
    description: 'Chiến lược indexing, partitioning và tối ưu hóa query execution plan trong PostgreSQL 17.',
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
      thumbnail_url: 'https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=800&auto=format&fit=crop&q=80',
      renditions: [
        { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 },
      ],
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
];
