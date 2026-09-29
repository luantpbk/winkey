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
} from '@winkey/api-client';
import { mockUsers, mockPublicProfiles, mockVideos, mockStudioVideos } from './fixtures';

let currentUser: User | null = mockUsers.creator;
let dynamicVideos: Video[] = [...mockVideos];
let dynamicStudioVideos: StudioVideo[] = [...mockStudioVideos];

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
];
