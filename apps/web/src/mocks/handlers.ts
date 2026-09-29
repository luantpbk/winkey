import { http, HttpResponse } from 'msw';
import type {
  User,
  VideoSummary,
  Video,
  StudioVideo,
  Problem,
  CreateUploadResponse,
  PresignPartsResponse,
  UploadStatus,
  StudioVideoPage,
  VideoPage,
  Comment,
  CommentPage,
  LikeState,
  SubscriptionState,
  CreateCommentRequest,
  EditCommentRequest,
} from '@winkey/api-client';
import { mockUsers, mockPublicProfiles, mockVideos, mockStudioVideos } from './fixtures';

let currentUser: User | null = mockUsers.creator;
let dynamicVideos: Video[] = [...mockVideos];
let dynamicStudioVideos: StudioVideo[] = [...mockStudioVideos];

const initialMockComments: Comment[] = [
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
    video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    parent_id: null,
    author: mockPublicProfiles.viet_coder,
    body: 'Video giải thích kiến trúc rất trực quan và chi tiết! Mong chờ tập tiếp theo về k3s ingress.',
    status: 'VISIBLE',
    reply_count: 2,
    created_at: '2026-09-16T12:00:00Z',
    edited_at: null,
    can_edit: false,
    can_delete: false,
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-c00000000002',
    video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    parent_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
    author: mockPublicProfiles.winkey_creator,
    body: 'Cảm ơn bạn! Phần ingress Traefik sẽ lên sóng trong tuần tới nhé.',
    status: 'VISIBLE',
    reply_count: 0,
    created_at: '2026-09-16T14:30:00Z',
    edited_at: null,
    can_edit: false,
    can_delete: false,
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-c00000000003',
    video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    parent_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
    author: mockPublicProfiles.viet_coder,
    body: 'Tuyệt vời, mình sẽ đón xem!',
    status: 'VISIBLE',
    reply_count: 0,
    created_at: '2026-09-16T15:00:00Z',
    edited_at: null,
    can_edit: false,
    can_delete: false,
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-c00000000004',
    video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    parent_id: null,
    author: null,
    body: '',
    status: 'DELETED',
    reply_count: 1,
    created_at: '2026-09-17T09:00:00Z',
    edited_at: null,
    can_edit: false,
    can_delete: false,
  },
  {
    id: '0192f5e4-7c1a-7b3e-9d2a-c00000000005',
    video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    parent_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000004',
    author: mockPublicProfiles.winkey_creator,
    body: 'Phản hồi cho câu hỏi đã xóa ở trên.',
    status: 'VISIBLE',
    reply_count: 0,
    created_at: '2026-09-17T10:15:00Z',
    edited_at: null,
    can_edit: false,
    can_delete: false,
  },
];

let dynamicComments: Comment[] = [...initialMockComments];
const dynamicLikes = new Map<string, { liked: boolean; like_count: number }>();
dynamicLikes.set('0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10', { liked: false, like_count: 8940 });

const dynamicSubscriptions = new Map<string, { subscribed: boolean; subscriber_count: number }>();
dynamicSubscriptions.set(mockUsers.creator.id, { subscribed: false, subscriber_count: 128450 });
dynamicSubscriptions.set(mockUsers.tech_guy.id, { subscribed: false, subscriber_count: 45200 });

function getDynamicComments(): Comment[] {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const stored = window.sessionStorage.getItem('wk_mock_comments');
      if (stored) return JSON.parse(stored);
    } catch {
      // ignore
    }
  }
  return dynamicComments;
}

function setDynamicComments(comments: Comment[]) {
  dynamicComments = comments;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.setItem('wk_mock_comments', JSON.stringify(comments));
    } catch {
      // ignore
    }
  }
}

function getDynamicLikes(): Map<string, { liked: boolean; like_count: number }> {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const stored = window.sessionStorage.getItem('wk_mock_likes');
      if (stored) {
        const obj = JSON.parse(stored);
        return new Map(Object.entries(obj));
      }
    } catch {
      // ignore
    }
  }
  return dynamicLikes;
}

function setDynamicLikes(likes: Map<string, { liked: boolean; like_count: number }>) {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const obj = Object.fromEntries(likes.entries());
      window.sessionStorage.setItem('wk_mock_likes', JSON.stringify(obj));
    } catch {
      // ignore
    }
  }
}

function getDynamicSubscriptions(): Map<string, { subscribed: boolean; subscriber_count: number }> {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const stored = window.sessionStorage.getItem('wk_mock_subs');
      if (stored) {
        const obj = JSON.parse(stored);
        return new Map(Object.entries(obj));
      }
    } catch {
      // ignore
    }
  }
  return dynamicSubscriptions;
}

function setDynamicSubscriptions(
  subs: Map<string, { subscribed: boolean; subscriber_count: number }>,
) {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const obj = Object.fromEntries(subs.entries());
      window.sessionStorage.setItem('wk_mock_subs', JSON.stringify(obj));
    } catch {
      // ignore
    }
  }
}

function getDynamicVideos(): Video[] {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const stored = window.sessionStorage.getItem('wk_mock_videos');
      if (stored) return JSON.parse(stored);
    } catch {
      // ignore storage errors
    }
  }
  return dynamicVideos;
}

function setDynamicVideos(videos: Video[]) {
  dynamicVideos = videos;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.setItem('wk_mock_videos', JSON.stringify(videos));
    } catch {
      // ignore storage errors
    }
  }
}

function getDynamicStudioVideos(): StudioVideo[] {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const stored = window.sessionStorage.getItem('wk_mock_studio_videos');
      if (stored) return JSON.parse(stored);
    } catch {
      // ignore storage errors
    }
  }
  return dynamicStudioVideos;
}

function setDynamicStudioVideos(videos: StudioVideo[]) {
  dynamicStudioVideos = videos;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.setItem('wk_mock_studio_videos', JSON.stringify(videos));
    } catch {
      // ignore storage errors
    }
  }
}

interface ActiveUpload {
  video_id: string;
  title: string;
  size_bytes: number;
  part_size: number;
  part_count: number;
  status: 'UPLOADING' | 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';
  progress: number;
  completed_parts: { part_number: number; etag: string }[];
}

const activeUploads = new Map<string, ActiveUpload>();

export const handlers = [
  // --- AUTH ENDPOINTS ---
  http.post('*/v1/auth/register', async ({ request }) => {
    const body = (await request.json()) as any;
    const errors: { field: string; message: string }[] = [];

    if (!body.email) errors.push({ field: 'email', message: 'Email is required' });
    if (!body.password || body.password.length < 8) {
      errors.push({ field: 'password', message: 'Password must be at least 8 characters' });
    }
    if (!body.handle) errors.push({ field: 'handle', message: 'Handle is required' });
    if (!body.display_name)
      errors.push({ field: 'display_name', message: 'Display name is required' });

    if (errors.length > 0) {
      const problem: Problem = {
        type: '/problems/validation',
        title: 'Validation Failed',
        status: 400,
        code: 'VALIDATION_FAILED',
        errors,
      };
      return HttpResponse.json(problem, { status: 400 });
    }

    if (body.email === 'conflict@winkey.vn') {
      const problem: Problem = {
        type: '/problems/conflict',
        title: 'Email already registered',
        status: 409,
        code: 'USER_ALREADY_EXISTS',
        errors: [{ field: 'email', message: 'This email is already in use' }],
      };
      return HttpResponse.json(problem, { status: 409 });
    }

    const newUser: User = {
      id: `0192f5e4-7c1a-7b3e-9d2a-${Date.now().toString(16).slice(-12)}`,
      email: body.email,
      email_verified: false,
      handle: body.handle,
      display_name: body.display_name,
      avatar_url:
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
      roles: ['viewer', 'creator'],
      created_at: new Date().toISOString(),
    };

    currentUser = newUser;
    mockPublicProfiles[newUser.handle] = {
      id: newUser.id,
      handle: newUser.handle,
      display_name: newUser.display_name,
      avatar_url: newUser.avatar_url,
    };

    return HttpResponse.json(
      {
        access_token: `mock_jwt_token_${newUser.id}`,
        token_type: 'Bearer',
        expires_in: 900,
        user: newUser,
      },
      {
        status: 201,
        headers: {
          'Set-Cookie': 'wk_rt=mock_refresh_token; HttpOnly; Path=/v1/auth; SameSite=Strict',
        },
      },
    );
  }),

  http.post('*/v1/auth/login', async ({ request }) => {
    const body = (await request.json()) as any;
    if (body.password === 'wrongpassword') {
      const problem: Problem = {
        type: '/problems/unauthorized',
        title: 'Invalid credentials',
        status: 401,
        code: 'INVALID_CREDENTIALS',
        detail: 'Email or password does not match.',
      };
      return HttpResponse.json(problem, { status: 401 });
    }

    currentUser = mockUsers.creator;
    return HttpResponse.json(
      {
        access_token: `mock_jwt_token_${currentUser.id}`,
        token_type: 'Bearer',
        expires_in: 900,
        user: currentUser,
      },
      {
        status: 200,
        headers: {
          'Set-Cookie': 'wk_rt=mock_refresh_token; HttpOnly; Path=/v1/auth; SameSite=Strict',
        },
      },
    );
  }),

  http.post('*/v1/auth/refresh', async () => {
    if (!currentUser) {
      // Default to logged-in creator for smooth development experience
      currentUser = mockUsers.creator;
    }
    return HttpResponse.json({
      access_token: `mock_jwt_token_refreshed_${currentUser.id}`,
      token_type: 'Bearer',
      expires_in: 900,
      user: currentUser,
    });
  }),

  http.post('*/v1/auth/logout', async () => {
    currentUser = null;
    return new HttpResponse(null, {
      status: 204,
      headers: {
        'Set-Cookie': 'wk_rt=; HttpOnly; Path=/v1/auth; Max-Age=0',
      },
    });
  }),

  http.get('*/v1/auth/me', async () => {
    if (!currentUser) {
      return HttpResponse.json(
        {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
        },
        { status: 401 },
      );
    }
    return HttpResponse.json(currentUser);
  }),

  http.get('*/v1/users/:handle', async ({ params }) => {
    const handle = params.handle as string;
    const profile = mockPublicProfiles[handle];
    if (!profile) {
      return HttpResponse.json(
        {
          type: '/problems/not-found',
          title: 'User not found',
          status: 404,
          code: 'NOT_FOUND',
        },
        { status: 404 },
      );
    }
    return HttpResponse.json(profile);
  }),

  // --- VIDEO ENDPOINTS ---
  http.get('*/v1/videos', async ({ request }) => {
    const url = new URL(request.url);
    const ownerId = url.searchParams.get('owner_id');
    const cursor = url.searchParams.get('cursor');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    const allVideos = getDynamicVideos();
    let filtered = allVideos.filter((v) => v.status === 'READY' && v.visibility === 'PUBLIC');
    if (ownerId) {
      filtered = filtered.filter((v) => v.owner.id === ownerId);
    }

    const startIndex = cursor ? parseInt(cursor, 10) : 0;
    const items: VideoSummary[] = filtered.slice(startIndex, startIndex + limit).map((v) => ({
      id: v.id,
      title: v.title,
      owner: v.owner,
      duration_ms: v.duration_ms || 0,
      view_count: v.view_count,
      published_at: v.published_at || v.created_at,
      thumbnail_url:
        v.playback?.thumbnail_url ||
        'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80',
    }));

    const nextIndex = startIndex + limit;
    const nextCursor = nextIndex < filtered.length ? nextIndex.toString() : null;

    const page: VideoPage = {
      items,
      next_cursor: nextCursor,
    };
    return HttpResponse.json(page);
  }),

  http.get('*/v1/videos/:id', async ({ params }) => {
    const videoId = params.id as string;
    const video = getDynamicVideos().find((v) => v.id === videoId);
    if (!video) {
      return HttpResponse.json(
        {
          type: '/problems/not-found',
          title: 'Video not found',
          status: 404,
          code: 'VIDEO_NOT_FOUND',
        },
        { status: 404 },
      );
    }
    return HttpResponse.json(video);
  }),

  http.post('*/v1/videos/:id/views', async ({ params, request }) => {
    const videoId = params.id as string;
    const body = (await request.json()) as { playback_id?: string; watched_ms?: number };
    const currentVideos = [...getDynamicVideos()];
    const videoIndex = currentVideos.findIndex((v) => v.id === videoId);

    if (videoIndex !== -1) {
      currentVideos[videoIndex] = {
        ...currentVideos[videoIndex],
        view_count: (currentVideos[videoIndex].view_count || 0) + 1,
      };
      setDynamicVideos(currentVideos);
    }

    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        const historyStr = window.sessionStorage.getItem('wk_mock_views') || '[]';
        const history = JSON.parse(historyStr);
        history.push({ videoId, ...body });
        window.sessionStorage.setItem('wk_mock_views', JSON.stringify(history));
      } catch {
        // ignore
      }
    }

    return HttpResponse.json({ counted: true }, { status: 202 });
  }),

  http.patch('*/v1/videos/:id', async ({ params, request }) => {
    const videoId = params.id as string;
    const body = (await request.json()) as any;
    const currentVideos = [...getDynamicVideos()];
    const videoIndex = currentVideos.findIndex((v) => v.id === videoId);
    if (videoIndex === -1) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Video not found', status: 404, code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    const current = currentVideos[videoIndex];
    const updated: Video = {
      ...current,
      title: body.title ?? current.title,
      description: body.description ?? current.description,
      visibility: body.visibility ?? current.visibility,
    };
    currentVideos[videoIndex] = updated;
    setDynamicVideos(currentVideos);
    return HttpResponse.json(updated);
  }),

  http.delete('*/v1/videos/:id', async ({ params }) => {
    const videoId = params.id as string;
    const currentVideos = getDynamicVideos().filter((v) => v.id !== videoId);
    setDynamicVideos(currentVideos);
    const currentStudio = getDynamicStudioVideos().filter((v) => v.id !== videoId);
    setDynamicStudioVideos(currentStudio);
    return new HttpResponse(null, { status: 204 });
  }),

  // --- UPLOAD & STUDIO ENDPOINTS ---
  http.post('*/v1/uploads', async ({ request }) => {
    const body = (await request.json()) as any;
    const videoId = `0192f5e4-7c1a-7b3e-9d2a-${Date.now().toString(16).slice(-12)}`;
    const sizeBytes = body.size_bytes || 50 * 1024 * 1024;
    // Limits: part_size = max(16 MiB, ceil(size_bytes / 10000)) rounded up to whole MiB
    const minPartSize = 16 * 1024 * 1024;
    const calculatedPartSize = Math.max(minPartSize, Math.ceil(sizeBytes / 10000));
    const partSize = Math.ceil(calculatedPartSize / (1024 * 1024)) * 1024 * 1024;
    const partCount = Math.max(1, Math.ceil(sizeBytes / partSize));

    activeUploads.set(videoId, {
      video_id: videoId,
      title: body.title,
      size_bytes: sizeBytes,
      part_size: partSize,
      part_count: partCount,
      status: 'UPLOADING',
      progress: 0,
      completed_parts: [],
    });

    const resp: CreateUploadResponse = {
      video_id: videoId,
      part_size: partSize,
      part_count: partCount,
    };
    return HttpResponse.json(resp, { status: 201 });
  }),

  http.post('*/v1/uploads/:id/parts', async ({ params, request }) => {
    const videoId = params.id as string;
    const upload = activeUploads.get(videoId);
    if (!upload) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Upload not found', status: 404, code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    const body = (await request.json()) as { part_numbers: number[] };
    const urls = body.part_numbers.map((partNumber) => ({
      part_number: partNumber,
      url: `/v1/mock-s3/${videoId}/${partNumber}`,
    }));

    const resp: PresignPartsResponse = {
      urls,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
    return HttpResponse.json(resp);
  }),

  // Mock S3 direct part PUT
  http.put('*/v1/mock-s3/:id/:part', async ({ params }) => {
    const partNumber = params.part as string;
    return new HttpResponse(null, {
      status: 200,
      headers: {
        ETag: `"mock-etag-${partNumber}"`,
        'Access-Control-Expose-Headers': 'ETag',
      },
    });
  }),

  http.post('*/v1/uploads/:id/complete', async ({ params }) => {
    const videoId = params.id as string;
    const upload = activeUploads.get(videoId);
    if (!upload) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Upload not found', status: 404, code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    upload.status = 'UPLOADED';
    upload.progress = 25;

    // Create studio record and public video
    const newStudioVideo: StudioVideo = {
      id: videoId,
      title: upload.title,
      visibility: 'PUBLIC',
      status: 'PROCESSING',
      progress: 35,
      error: null,
      duration_ms: 180000,
      created_at: new Date().toISOString(),
      thumbnail_url:
        'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=80',
    };
    const currentStudio = [newStudioVideo, ...getDynamicStudioVideos()];
    setDynamicStudioVideos(currentStudio);

    const newVideo: Video = {
      id: videoId,
      title: upload.title,
      description: 'Uploaded via Winkey Web Creator Studio.',
      owner: currentUser
        ? {
            id: currentUser.id,
            handle: currentUser.handle,
            display_name: currentUser.display_name,
            avatar_url: currentUser.avatar_url,
          }
        : mockPublicProfiles.winkey_creator,
      visibility: 'PUBLIC',
      status: 'READY',
      duration_ms: 180000,
      width: 1920,
      height: 1080,
      view_count: 1,
      like_count: 0,
      published_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      playback: {
        hls_url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
        thumbnail_url:
          'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=80',
        renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 }],
      },
    };
    const currentVideos = [newVideo, ...getDynamicVideos()];
    setDynamicVideos(currentVideos);

    const resp: UploadStatus = {
      video_id: videoId,
      status: 'UPLOADED',
      progress: 25,
      error: null,
    };
    return HttpResponse.json(resp, { status: 202 });
  }),

  http.get('*/v1/uploads/:id', async ({ params }) => {
    const videoId = params.id as string;
    const upload = activeUploads.get(videoId);
    const studioList = [...getDynamicStudioVideos()];
    const studioVideo = studioList.find((v) => v.id === videoId);

    if (studioVideo) {
      if (studioVideo.status === 'PROCESSING') {
        studioVideo.progress = Math.min(100, (studioVideo.progress || 0) + 25);
        if (studioVideo.progress >= 100) {
          studioVideo.status = 'READY';
        }
        setDynamicStudioVideos(studioList);
      }
      const resp: UploadStatus = {
        video_id: videoId,
        status: studioVideo.status,
        progress: studioVideo.progress,
        error: studioVideo.error,
      };
      return HttpResponse.json(resp);
    }

    if (!upload) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Upload not found', status: 404, code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const resp: UploadStatus = {
      video_id: videoId,
      status: upload.status,
      progress: upload.progress,
      error: null,
    };
    return HttpResponse.json(resp);
  }),

  http.delete('*/v1/uploads/:id', async ({ params }) => {
    const videoId = params.id as string;
    activeUploads.delete(videoId);
    const sList = getDynamicStudioVideos().filter((v) => v.id !== videoId);
    setDynamicStudioVideos(sList);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/v1/studio/videos', async () => {
    const page: StudioVideoPage = {
      items: getDynamicStudioVideos(),
      next_cursor: null,
    };
    return HttpResponse.json(page);
  }),

  // --- Social: Comments ---
  http.get('*/v1/videos/:id/comments', async ({ params, request }) => {
    const videoId = params.id as string;
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    const all = getDynamicComments().filter(
      (c) => c.video_id === videoId && c.parent_id === null && c.status !== 'HIDDEN',
    );
    // Sort newest first
    all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // Hide deleted tombstones with 0 replies
    const visibleTopLevel = all.filter((c) => !(c.status === 'DELETED' && c.reply_count === 0));

    let startIndex = 0;
    if (cursor) {
      const idx = visibleTopLevel.findIndex((c) => c.id === cursor);
      if (idx !== -1) startIndex = idx + 1;
    }

    const items = visibleTopLevel.slice(startIndex, startIndex + limit).map((c) => ({
      ...c,
      can_edit: Boolean(currentUser && c.author?.id === currentUser.id && c.status === 'VISIBLE'),
      can_delete: Boolean(
        currentUser && (c.author?.id === currentUser.id || currentUser.roles.includes('admin')),
      ),
    }));

    const nextIndex = startIndex + limit;
    const next_cursor =
      nextIndex < visibleTopLevel.length ? visibleTopLevel[nextIndex - 1].id : null;

    const page: CommentPage = {
      items,
      next_cursor,
    };
    return HttpResponse.json(page);
  }),

  http.post('*/v1/videos/:id/comments', async ({ params, request }) => {
    const videoId = params.id as string;
    if (!currentUser) {
      const problem: Problem = {
        type: '/problems/unauthorized',
        title: 'Unauthorized',
        status: 401,
        code: 'UNAUTHORIZED',
      };
      return HttpResponse.json(problem, { status: 401 });
    }

    // Rate limit mock header / trigger
    if (request.headers.get('x-mock-rate-limit') === '1') {
      const problem: Problem = {
        type: '/problems/too-many-requests',
        title: 'Too Many Requests',
        status: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        detail: 'Rate limit exceeded. Please wait.',
      };
      return HttpResponse.json(problem, { status: 429, headers: { 'Retry-After': '30' } });
    }

    const body = (await request.json()) as CreateCommentRequest;
    const text = (body.body || '').trim();

    if (!text || text.length > 2000) {
      const problem: Problem = {
        type: '/problems/validation',
        title: 'Validation Failed',
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'Comment body must be between 1 and 2000 characters',
      };
      return HttpResponse.json(problem, { status: 400 });
    }

    const currentList = [...getDynamicComments()];
    let targetParentId: string | null = null;

    if (body.parent_id) {
      const parent = currentList.find((c) => c.id === body.parent_id);
      if (!parent || parent.status === 'HIDDEN') {
        const problem: Problem = {
          type: '/problems/not-found',
          title: 'Parent comment not found',
          status: 404,
          code: 'PARENT_NOT_FOUND',
        };
        return HttpResponse.json(problem, { status: 404 });
      }
      // Strict 2-level cap: If parent has a parent, attach to the root parent
      targetParentId = parent.parent_id ? parent.parent_id : parent.id;
      const rootParentIdx = currentList.findIndex((c) => c.id === targetParentId);
      if (rootParentIdx !== -1) {
        currentList[rootParentIdx] = {
          ...currentList[rootParentIdx],
          reply_count: (currentList[rootParentIdx].reply_count || 0) + 1,
        };
      }
    }

    const newComment: Comment = {
      id: `0192f5e4-7c1a-7b3e-9d2a-${Date.now().toString(16).slice(-12)}`,
      video_id: videoId,
      parent_id: targetParentId,
      author: {
        id: currentUser.id,
        handle: currentUser.handle,
        display_name: currentUser.display_name,
        avatar_url: currentUser.avatar_url,
      },
      body: text,
      status: 'VISIBLE',
      reply_count: 0,
      created_at: new Date().toISOString(),
      edited_at: null,
      can_edit: true,
      can_delete: true,
    };

    currentList.push(newComment);
    setDynamicComments(currentList);

    return HttpResponse.json(newComment, {
      status: 201,
      headers: {
        Location: `/v1/comments/${newComment.id}`,
      },
    });
  }),

  http.get('*/v1/comments/:id', async ({ params }) => {
    const commentId = params.id as string;
    const comment = getDynamicComments().find((c) => c.id === commentId);
    if (!comment || comment.status === 'HIDDEN') {
      const problem: Problem = {
        type: '/problems/not-found',
        title: 'Comment not found',
        status: 404,
        code: 'NOT_FOUND',
      };
      return HttpResponse.json(problem, { status: 404 });
    }
    return HttpResponse.json({
      ...comment,
      can_edit: Boolean(
        currentUser && comment.author?.id === currentUser.id && comment.status === 'VISIBLE',
      ),
      can_delete: Boolean(
        currentUser &&
        (comment.author?.id === currentUser.id || currentUser.roles.includes('admin')),
      ),
    });
  }),

  http.patch('*/v1/comments/:id', async ({ params, request }) => {
    const commentId = params.id as string;
    if (!currentUser) {
      return HttpResponse.json(
        {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
        },
        { status: 401 },
      );
    }
    const currentList = [...getDynamicComments()];
    const index = currentList.findIndex((c) => c.id === commentId);
    if (index === -1) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Comment not found', status: 404, code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const comment = currentList[index];
    if (comment.author?.id !== currentUser.id) {
      return HttpResponse.json(
        { type: '/problems/forbidden', title: 'Forbidden', status: 403, code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    const body = (await request.json()) as EditCommentRequest;
    const text = (body.body || '').trim();
    if (!text || text.length > 2000) {
      return HttpResponse.json(
        {
          type: '/problems/validation',
          title: 'Validation Failed',
          status: 400,
          code: 'VALIDATION_FAILED',
        },
        { status: 400 },
      );
    }

    const updated: Comment = {
      ...comment,
      body: text,
      edited_at: new Date().toISOString(),
      can_edit: true,
      can_delete: true,
    };
    currentList[index] = updated;
    setDynamicComments(currentList);

    return HttpResponse.json(updated);
  }),

  http.delete('*/v1/comments/:id', async ({ params }) => {
    const commentId = params.id as string;
    if (!currentUser) {
      return HttpResponse.json(
        {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
        },
        { status: 401 },
      );
    }
    const currentList = [...getDynamicComments()];
    const index = currentList.findIndex((c) => c.id === commentId);
    if (index === -1) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Comment not found', status: 404, code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const comment = currentList[index];
    // Idempotent: set status = 'DELETED' and body = ''
    currentList[index] = {
      ...comment,
      status: 'DELETED',
      body: '',
    };
    setDynamicComments(currentList);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/v1/comments/:id/replies', async ({ params, request }) => {
    const parentId = params.id as string;
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    const replies = getDynamicComments().filter(
      (c) => c.parent_id === parentId && c.status !== 'HIDDEN',
    );
    // Oldest first per contract
    replies.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    let startIndex = 0;
    if (cursor) {
      const idx = replies.findIndex((c) => c.id === cursor);
      if (idx !== -1) startIndex = idx + 1;
    }

    const items = replies.slice(startIndex, startIndex + limit).map((c) => ({
      ...c,
      can_edit: Boolean(currentUser && c.author?.id === currentUser.id && c.status === 'VISIBLE'),
      can_delete: Boolean(
        currentUser && (c.author?.id === currentUser.id || currentUser.roles.includes('admin')),
      ),
    }));

    const nextIndex = startIndex + limit;
    const next_cursor = nextIndex < replies.length ? replies[nextIndex - 1].id : null;

    const page: CommentPage = {
      items,
      next_cursor,
    };
    return HttpResponse.json(page);
  }),

  // --- Social: Likes ---
  http.get('*/v1/videos/:id/like', async ({ params }) => {
    const videoId = params.id as string;
    const likes = getDynamicLikes();
    const current = likes.get(videoId) || { liked: false, like_count: 8940 };
    const resp: LikeState = {
      video_id: videoId,
      liked: currentUser ? current.liked : false,
      like_count: current.like_count,
    };
    return HttpResponse.json(resp);
  }),

  http.put('*/v1/videos/:id/like', async ({ params }) => {
    const videoId = params.id as string;
    if (!currentUser) {
      return HttpResponse.json(
        {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
        },
        { status: 401 },
      );
    }
    const likes = getDynamicLikes();
    const current = likes.get(videoId) || { liked: false, like_count: 8940 };
    if (!current.liked) {
      current.liked = true;
      current.like_count += 1;
      likes.set(videoId, current);
      setDynamicLikes(likes);
    }
    const resp: LikeState = {
      video_id: videoId,
      liked: true,
      like_count: current.like_count,
    };
    return HttpResponse.json(resp);
  }),

  http.delete('*/v1/videos/:id/like', async ({ params }) => {
    const videoId = params.id as string;
    if (!currentUser) {
      return HttpResponse.json(
        {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
        },
        { status: 401 },
      );
    }
    const likes = getDynamicLikes();
    const current = likes.get(videoId) || { liked: false, like_count: 8940 };
    if (current.liked) {
      current.liked = false;
      current.like_count = Math.max(0, current.like_count - 1);
      likes.set(videoId, current);
      setDynamicLikes(likes);
    }
    const resp: LikeState = {
      video_id: videoId,
      liked: false,
      like_count: current.like_count,
    };
    return HttpResponse.json(resp);
  }),

  // --- Social: Subscriptions ---
  http.get('*/v1/channels/:id/subscription', async ({ params }) => {
    const channelId = params.id as string;
    const subs = getDynamicSubscriptions();
    const current = subs.get(channelId) || { subscribed: false, subscriber_count: 100 };
    const resp: SubscriptionState = {
      channel_id: channelId,
      subscribed: currentUser ? current.subscribed : false,
      subscriber_count: current.subscriber_count,
    };
    return HttpResponse.json(resp);
  }),

  http.put('*/v1/channels/:id/subscription', async ({ params }) => {
    const channelId = params.id as string;
    if (!currentUser) {
      return HttpResponse.json(
        {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
        },
        { status: 401 },
      );
    }
    if (currentUser.id === channelId) {
      const problem: Problem = {
        type: '/problems/bad-request',
        title: 'Cannot subscribe to self',
        status: 400,
        code: 'CANNOT_SUBSCRIBE_SELF',
        detail: 'Cannot subscribe to your own channel',
      };
      return HttpResponse.json(problem, { status: 400 });
    }
    const subs = getDynamicSubscriptions();
    const current = subs.get(channelId) || { subscribed: false, subscriber_count: 100 };
    if (!current.subscribed) {
      current.subscribed = true;
      current.subscriber_count += 1;
      subs.set(channelId, current);
      setDynamicSubscriptions(subs);
    }
    const resp: SubscriptionState = {
      channel_id: channelId,
      subscribed: true,
      subscriber_count: current.subscriber_count,
    };
    return HttpResponse.json(resp);
  }),

  http.delete('*/v1/channels/:id/subscription', async ({ params }) => {
    const channelId = params.id as string;
    if (!currentUser) {
      return HttpResponse.json(
        {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
        },
        { status: 401 },
      );
    }
    const subs = getDynamicSubscriptions();
    const current = subs.get(channelId) || { subscribed: false, subscriber_count: 100 };
    if (current.subscribed) {
      current.subscribed = false;
      current.subscriber_count = Math.max(0, current.subscriber_count - 1);
      subs.set(channelId, current);
      setDynamicSubscriptions(subs);
    }
    const resp: SubscriptionState = {
      channel_id: channelId,
      subscribed: false,
      subscriber_count: current.subscriber_count,
    };
    return HttpResponse.json(resp);
  }),
];
