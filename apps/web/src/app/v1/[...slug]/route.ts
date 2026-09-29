import { NextRequest, NextResponse } from 'next/server';
import { mockUsers, mockPublicProfiles, mockVideos, mockStudioVideos } from '../../../mocks/fixtures';
import type {
  User,
  Video,
  StudioVideo,
  VideoSummary,
  VideoPage,
  StudioVideoPage,
  CreateUploadResponse,
  PresignPartsResponse,
  UploadStatus,
  Problem,
} from '@winkey/api-client';

let currentUser: User | null = mockUsers.creator;
const dynamicVideos: Video[] = [...mockVideos];
const dynamicStudioVideos: StudioVideo[] = [...mockStudioVideos];

interface ActiveUpload {
  video_id: string;
  title: string;
  size_bytes: number;
  part_size: number;
  part_count: number;
  status: 'UPLOADING' | 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';
  progress: number;
}
const activeUploads = new Map<string, ActiveUpload>();

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const path = slug.join('/');

  // GET /v1/auth/me
  if (path === 'auth/me') {
    if (!currentUser) {
      return NextResponse.json({ type: '/problems/unauthorized', title: 'Unauthorized', status: 401 }, { status: 401 });
    }
    return NextResponse.json(currentUser);
  }

  // GET /v1/users/:handle
  if (slug[0] === 'users' && slug[1]) {
    const profile = mockPublicProfiles[slug[1]];
    if (!profile) {
      return NextResponse.json({ type: '/problems/not-found', title: 'User not found', status: 404 }, { status: 404 });
    }
    return NextResponse.json(profile);
  }

  // GET /v1/videos
  if (path === 'videos') {
    const url = new URL(request.url);
    const ownerId = url.searchParams.get('owner_id');
    const cursor = url.searchParams.get('cursor');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    let filtered = dynamicVideos.filter((v) => v.status === 'READY' && v.visibility === 'PUBLIC');
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
      thumbnail_url: v.playback?.thumbnail_url || 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80',
    }));

    const nextIndex = startIndex + limit;
    const nextCursor = nextIndex < filtered.length ? nextIndex.toString() : null;

    const page: VideoPage = { items, next_cursor: nextCursor };
    return NextResponse.json(page);
  }

  // GET /v1/videos/:id
  if (slug[0] === 'videos' && slug[1]) {
    const video = dynamicVideos.find((v) => v.id === slug[1]);
    if (!video) {
      return NextResponse.json({ type: '/problems/not-found', title: 'Video not found', status: 404 }, { status: 404 });
    }
    return NextResponse.json(video);
  }

  // GET /v1/studio/videos
  if (path === 'studio/videos') {
    const page: StudioVideoPage = { items: dynamicStudioVideos, next_cursor: null };
    return NextResponse.json(page);
  }

  // GET /v1/uploads/:id
  if (slug[0] === 'uploads' && slug[1]) {
    const videoId = slug[1];
    const studioVideo = dynamicStudioVideos.find((v) => v.id === videoId);
    if (studioVideo) {
      if (studioVideo.status === 'PROCESSING') {
        studioVideo.progress = Math.min(100, (studioVideo.progress || 0) + 25);
        if (studioVideo.progress >= 100) {
          studioVideo.status = 'READY';
        }
      }
      const resp: UploadStatus = {
        video_id: videoId,
        status: studioVideo.status,
        progress: studioVideo.progress,
        error: studioVideo.error,
      };
      return NextResponse.json(resp);
    }

    const upload = activeUploads.get(videoId);
    if (upload) {
      return NextResponse.json({
        video_id: videoId,
        status: upload.status,
        progress: upload.progress,
        error: null,
      });
    }

    return NextResponse.json({ type: '/problems/not-found', title: 'Upload not found', status: 404 }, { status: 404 });
  }

  return NextResponse.json({ type: '/problems/not-found', title: 'Not found', status: 404 }, { status: 404 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const path = slug.join('/');
  let body: any = {};
  try {
    body = await request.json();
  } catch {}

  // POST /v1/auth/register
  if (path === 'auth/register') {
    const errors: { field: string; message: string }[] = [];
    if (!body.email) errors.push({ field: 'email', message: 'Email is required' });
    if (!body.password || body.password.length < 8) errors.push({ field: 'password', message: 'Password must be at least 8 characters' });
    if (!body.handle) errors.push({ field: 'handle', message: 'Handle is required' });
    if (!body.display_name) errors.push({ field: 'display_name', message: 'Display name is required' });

    if (errors.length > 0) {
      return NextResponse.json({ type: '/problems/validation', title: 'Validation Failed', status: 400, errors }, { status: 400 });
    }

    const newUser: User = {
      id: `0192f5e4-7c1a-7b3e-9d2a-${Date.now().toString(16).slice(-12)}`,
      email: body.email,
      email_verified: false,
      handle: body.handle,
      display_name: body.display_name,
      avatar_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
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

    const res = NextResponse.json({
      access_token: `mock_jwt_token_${newUser.id}`,
      token_type: 'Bearer',
      expires_in: 900,
      user: newUser,
    }, { status: 201 });
    res.cookies.set('wk_rt', 'mock_refresh_token', { httpOnly: true, path: '/v1/auth', sameSite: 'strict' });
    return res;
  }

  // POST /v1/auth/login
  if (path === 'auth/login') {
    if (body.password === 'wrongpassword') {
      return NextResponse.json({ type: '/problems/unauthorized', title: 'Invalid credentials', status: 401 }, { status: 401 });
    }
    currentUser = mockUsers.creator;
    const res = NextResponse.json({
      access_token: `mock_jwt_token_${currentUser.id}`,
      token_type: 'Bearer',
      expires_in: 900,
      user: currentUser,
    });
    res.cookies.set('wk_rt', 'mock_refresh_token', { httpOnly: true, path: '/v1/auth', sameSite: 'strict' });
    return res;
  }

  // POST /v1/auth/refresh
  if (path === 'auth/refresh') {
    if (!currentUser) currentUser = mockUsers.creator;
    return NextResponse.json({
      access_token: `mock_jwt_token_refreshed_${currentUser.id}`,
      token_type: 'Bearer',
      expires_in: 900,
      user: currentUser,
    });
  }

  // POST /v1/auth/logout
  if (path === 'auth/logout') {
    currentUser = null;
    const res = new NextResponse(null, { status: 204 });
    res.cookies.delete('wk_rt');
    return res;
  }

  // POST /v1/uploads
  if (path === 'uploads') {
    const videoId = `0192f5e4-7c1a-7b3e-9d2a-${Date.now().toString(16).slice(-12)}`;
    const sizeBytes = body.size_bytes || 50 * 1024 * 1024;
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
    });

    const resp: CreateUploadResponse = {
      video_id: videoId,
      part_size: partSize,
      part_count: partCount,
    };
    return NextResponse.json(resp, { status: 201 });
  }

  // POST /v1/uploads/:id/parts
  if (slug[0] === 'uploads' && slug[2] === 'parts') {
    const videoId = slug[1];
    const partNumbers: number[] = body.part_numbers || [1];
    const urls = partNumbers.map((n) => ({
      part_number: n,
      url: `/v1/mock-s3/${videoId}/${n}`,
    }));
    const resp: PresignPartsResponse = {
      urls,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
    return NextResponse.json(resp);
  }

  // POST /v1/uploads/:id/complete
  if (slug[0] === 'uploads' && slug[2] === 'complete') {
    const videoId = slug[1];
    const upload = activeUploads.get(videoId);
    const videoTitle = upload?.title || 'Uploaded Video';

    const newStudioVideo: StudioVideo = {
      id: videoId,
      title: videoTitle,
      visibility: 'PUBLIC',
      status: 'PROCESSING',
      progress: 35,
      error: null,
      duration_ms: 180000,
      created_at: new Date().toISOString(),
      thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=80',
    };
    dynamicStudioVideos.unshift(newStudioVideo);

    const newVideo: Video = {
      id: videoId,
      title: videoTitle,
      description: 'Uploaded via Winkey Web Creator Studio.',
      owner: currentUser ? {
        id: currentUser.id,
        handle: currentUser.handle,
        display_name: currentUser.display_name,
        avatar_url: currentUser.avatar_url,
      } : mockPublicProfiles.winkey_creator,
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
        thumbnail_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=80',
        renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 }],
      },
    };
    dynamicVideos.unshift(newVideo);

    return NextResponse.json({
      video_id: videoId,
      status: 'UPLOADED',
      progress: 25,
      error: null,
    }, { status: 202 });
  }

  return NextResponse.json({ type: '/problems/not-found', title: 'Not found', status: 404 }, { status: 404 });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  // PUT /v1/mock-s3/:id/:part
  if (slug[0] === 'mock-s3') {
    const partNumber = slug[2] || '1';
    return new NextResponse(null, {
      status: 200,
      headers: {
        ETag: `"mock-etag-${partNumber}"`,
        'Access-Control-Expose-Headers': 'ETag',
      },
    });
  }
  return new NextResponse(null, { status: 404 });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  if (slug[0] === 'uploads' && slug[1]) {
    activeUploads.delete(slug[1]);
    const idx = dynamicStudioVideos.findIndex((v) => v.id === slug[1]);
    if (idx !== -1) dynamicStudioVideos.splice(idx, 1);
    return new NextResponse(null, { status: 204 });
  }
  if (slug[0] === 'videos' && slug[1]) {
    const idx = dynamicVideos.findIndex((v) => v.id === slug[1]);
    if (idx !== -1) dynamicVideos.splice(idx, 1);
    const sIdx = dynamicStudioVideos.findIndex((v) => v.id === slug[1]);
    if (sIdx !== -1) dynamicStudioVideos.splice(sIdx, 1);
    return new NextResponse(null, { status: 204 });
  }
  return new NextResponse(null, { status: 404 });
}
