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
  AdminUser,
  AdminUserPage,
  ModerationCase,
  ModerationCasePage,
  AuditEntry,
  AuditEntryPage,
  ReportReceipt,
  ResolveCaseResult,
  Role,
  UserStatus,
  ReportTargetType,
  ReportReason,
  ReportStatus,
  UpdateMeRequest,
  ChangePasswordRequest,
  DeleteMeRequest,
  SubtitleTrack,
  PutSubtitleRequest,
  PlaybackHeartbeatBatch,
  PlaybackSample,
  PlaybackHeartbeatResult,
  Notification,
  NotificationPage,
  MarkNotificationsReadRequest,
} from '@winkey/api-client';
import {
  mockUsers,
  mockPublicProfiles,
  mockVideos,
  mockStudioVideos,
  mockAdminUsers,
  mockModerationCases,
  mockAuditEntries,
} from './fixtures';

let currentUser: User | null = mockUsers.creator;
let dynamicVideos: Video[] = [...mockVideos];
let dynamicStudioVideos: StudioVideo[] = [...mockStudioVideos];
let dynamicAdminUsers: AdminUser[] = [...mockAdminUsers];
let dynamicModerationCases: ModerationCase[] = [...mockModerationCases];
let dynamicAuditEntries: AuditEntry[] = [...mockAuditEntries];

export function setMockCurrentUser(user: User | null) {
  currentUser = user;
}
export function getMockCurrentUser(): User | null {
  return currentUser;
}
export function callerFromRequest(request: Request): User | null {
  const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    for (const u of Object.values(mockUsers)) {
      if (token.includes(u.id)) {
        return u;
      }
    }
  }
  return currentUser;
}
export function setDynamicAdminUsers(users: AdminUser[]) {
  dynamicAdminUsers = [...users];
}
export function getDynamicAdminUsers(): AdminUser[] {
  return dynamicAdminUsers;
}
export function setDynamicModerationCases(cases: ModerationCase[]) {
  dynamicModerationCases = [...cases];
}
export function getDynamicModerationCases(): ModerationCase[] {
  return dynamicModerationCases;
}
export function setDynamicAuditEntries(entries: AuditEntry[]) {
  dynamicAuditEntries = [...entries];
}
export function getDynamicAuditEntries(): AuditEntry[] {
  return dynamicAuditEntries;
}
let mockTrendingEmpty = false;
export function setMockTrendingEmpty(val: boolean) {
  mockTrendingEmpty = val;
}
export function getMockTrendingEmpty(): boolean {
  return mockTrendingEmpty;
}

let mockSubscriptionEmpty = false;
export function setMockSubscriptionEmpty(val: boolean) {
  mockSubscriptionEmpty = val;
}
export function getMockSubscriptionEmpty(): boolean {
  return mockSubscriptionEmpty;
}

let mockSubscriptionVideosOverride: VideoSummary[] | null = null;
export function setMockSubscriptionVideosOverride(videos: VideoSummary[] | null) {
  mockSubscriptionVideosOverride = videos;
}

let mockHeartbeat429 = false;
export function setMockHeartbeat429(val: boolean) {
  mockHeartbeat429 = val;
}
export function getMockHeartbeat429(): boolean {
  return mockHeartbeat429;
}

let mockRecordedHeartbeats: PlaybackSample[] = [];
export function getMockRecordedHeartbeats(): PlaybackSample[] {
  return mockRecordedHeartbeats;
}
export function clearMockRecordedHeartbeats(): void {
  mockRecordedHeartbeats = [];
}

export function resetModerationMocks() {
  currentUser = mockUsers.creator;
  dynamicVideos = [...mockVideos];
  dynamicStudioVideos = [...mockStudioVideos];
  dynamicAdminUsers = [...mockAdminUsers];
  dynamicModerationCases = [...mockModerationCases];
  dynamicAuditEntries = [...mockAuditEntries];
  mockTrendingEmpty = false;
  mockSubscriptionEmpty = false;
  mockSubscriptionVideosOverride = null;
  mockHeartbeat429 = false;
  mockRecordedHeartbeats = [];
  resetNotificationMocks();
}

const initialMockNotifications: Notification[] = [
  {
    id: '0192f5e4-9000-7000-8000-000000000001',
    kind: 'VIDEO_COMMENT',
    actor: {
      id: mockPublicProfiles.viet_coder.id,
      handle: mockPublicProfiles.viet_coder.handle,
      display_name: mockPublicProfiles.viet_coder.display_name,
      avatar_url: mockPublicProfiles.viet_coder.avatar_url,
    },
    video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    comment_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
    read_at: null,
    created_at: '2026-09-20T10:00:00Z',
  },
  {
    id: '0192f5e4-9000-7000-8000-000000000002',
    kind: 'COMMENT_REPLY',
    actor: {
      id: mockPublicProfiles.viet_coder.id,
      handle: mockPublicProfiles.viet_coder.handle,
      display_name: mockPublicProfiles.viet_coder.display_name,
      avatar_url: mockPublicProfiles.viet_coder.avatar_url,
    },
    video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    comment_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000002',
    read_at: null,
    created_at: '2026-09-20T09:30:00Z',
  },
  {
    id: '0192f5e4-9000-7000-8000-000000000003',
    kind: 'VIDEO_PUBLISHED',
    actor: {
      id: mockPublicProfiles.viet_coder.id,
      handle: mockPublicProfiles.viet_coder.handle,
      display_name: mockPublicProfiles.viet_coder.display_name,
      avatar_url: mockPublicProfiles.viet_coder.avatar_url,
    },
    video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
    comment_id: null,
    read_at: null,
    created_at: '2026-09-20T09:00:00Z',
  },
  {
    id: '0192f5e4-9000-7000-8000-000000000004',
    kind: 'NEW_SUBSCRIBER',
    actor: {
      id: mockPublicProfiles.viet_coder.id,
      handle: mockPublicProfiles.viet_coder.handle,
      display_name: mockPublicProfiles.viet_coder.display_name,
      avatar_url: mockPublicProfiles.viet_coder.avatar_url,
    },
    video_id: null,
    comment_id: null,
    read_at: '2026-09-19T08:00:00Z',
    created_at: '2026-09-19T08:00:00Z',
  },
];

let dynamicNotifications: Notification[] = [...initialMockNotifications];
let mockNotificationsCapped = false;
let mockNotificationsEmpty = false;
let mockNotificationsError = false;

export function setMockNotificationsCapped(val: boolean) {
  mockNotificationsCapped = val;
}
export function getMockNotificationsCapped(): boolean {
  return mockNotificationsCapped;
}
export function setMockNotificationsEmpty(val: boolean) {
  mockNotificationsEmpty = val;
}
export function getMockNotificationsEmpty(): boolean {
  return mockNotificationsEmpty;
}
export function setMockNotificationsError(val: boolean) {
  mockNotificationsError = val;
}
export function setDynamicNotifications(notifications: Notification[]) {
  dynamicNotifications = [...notifications];
}
export function getDynamicNotifications(): Notification[] {
  return dynamicNotifications;
}
export function resetNotificationMocks() {
  dynamicNotifications = initialMockNotifications.map((n) => ({ ...n }));
  mockNotificationsCapped = false;
  mockNotificationsEmpty = false;
  mockNotificationsError = false;
}

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
    const body = (await request.json()) as { email?: string; password?: string };
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

    if (body.email === 'admin@winkey.vn') {
      currentUser = mockUsers.admin;
    } else if (body.email === 'mod@winkey.vn' || body.email === 'moderator@winkey.vn') {
      currentUser = mockUsers.moderator;
    } else {
      currentUser = mockUsers.creator;
    }

    return HttpResponse.json(
      {
        access_token: `mock-access-${currentUser.id}`,
        token_type: 'Bearer',
        expires_in: 900,
        user: currentUser,
      },
      {
        status: 200,
        headers: {
          'Set-Cookie': `wk_rt=mock-refresh-${currentUser.id}; HttpOnly; Path=/; SameSite=Lax`,
        },
      },
    );
  }),

  http.post('*/v1/auth/refresh', async ({ cookies, request }) => {
    if (!currentUser) {
      return new HttpResponse(null, { status: 401 });
    }
    const cookieHeader = request.headers.get('cookie') || '';
    const rt = cookies.wk_rt || cookieHeader;
    for (const u of Object.values(mockUsers)) {
      if (rt && rt.includes(u.id)) {
        currentUser = u;
        break;
      }
    }

    return HttpResponse.json({
      access_token: `mock-access-${currentUser.id}`,
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
        'Set-Cookie': 'wk_rt=; HttpOnly; Path=/; Max-Age=0',
      },
    });
  }),

  http.get('*/v1/auth/me', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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
    return HttpResponse.json(caller);
  }),

  http.patch('*/v1/auth/me', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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

    const body = (await request.json()) as UpdateMeRequest;
    if (!body || (body.display_name === undefined && body.handle === undefined)) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Bad Request',
          status: 400,
          code: 'BAD_REQUEST',
          detail: 'At least one field is required.',
        },
        { status: 400 },
      );
    }

    if (body.display_name !== undefined) {
      if (body.display_name.trim().length === 0 || body.display_name.length > 50) {
        return HttpResponse.json(
          {
            type: '/problems/bad-request',
            title: 'Validation Error',
            status: 400,
            code: 'VALIDATION_ERROR',
            errors: [{ field: 'display_name', message: 'Tên hiển thị phải từ 1 đến 50 ký tự' }],
          },
          { status: 400 },
        );
      }
    }

    if (body.handle !== undefined) {
      const handleRegex = /^[A-Za-z0-9_.]{3,30}$/;
      if (!handleRegex.test(body.handle)) {
        return HttpResponse.json(
          {
            type: '/problems/bad-request',
            title: 'Validation Error',
            status: 400,
            code: 'VALIDATION_ERROR',
            errors: [
              {
                field: 'handle',
                message: 'Handle chỉ gồm chữ, số, dấu chấm hoặc gạch dưới (3-30 ký tự)',
              },
            ],
          },
          { status: 400 },
        );
      }

      // Check handle collision (case-insensitive) across mock users
      const lower = body.handle.toLowerCase();
      const collision = Object.values(mockUsers).find(
        (u) => u.id !== caller.id && u.handle.toLowerCase() === lower,
      );
      if (collision) {
        return HttpResponse.json(
          {
            type: '/problems/conflict',
            title: 'Handle already taken',
            status: 409,
            code: 'HANDLE_TAKEN',
            detail: 'This handle is already taken by another account.',
          },
          { status: 409 },
        );
      }
    }

    const updatedUser: User = {
      ...caller,
      ...(body.display_name !== undefined ? { display_name: body.display_name.trim() } : {}),
      ...(body.handle !== undefined ? { handle: body.handle } : {}),
    };

    // Update in mock fixtures
    for (const key of Object.keys(mockUsers)) {
      if (mockUsers[key].id === caller.id) {
        mockUsers[key] = updatedUser;
      }
    }
    const adminIdx = dynamicAdminUsers.findIndex((u) => u.id === caller.id);
    if (adminIdx !== -1) {
      dynamicAdminUsers[adminIdx] = {
        ...dynamicAdminUsers[adminIdx],
        display_name: updatedUser.display_name,
        handle: updatedUser.handle,
      };
    }
    if (currentUser?.id === caller.id) {
      currentUser = updatedUser;
    }

    return HttpResponse.json(updatedUser);
  }),

  http.put('*/v1/auth/me/password', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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

    const body = (await request.json()) as ChangePasswordRequest;
    if (
      !body ||
      !body.new_password ||
      body.new_password.length < 8 ||
      body.new_password.length > 128
    ) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Validation Error',
          status: 400,
          code: 'VALIDATION_ERROR',
          errors: [{ field: 'new_password', message: 'Mật khẩu phải từ 8 đến 128 ký tự' }],
        },
        { status: 400 },
      );
    }

    if (caller.has_password) {
      if (!body.current_password || body.current_password === 'wrongpassword') {
        return HttpResponse.json(
          {
            type: '/problems/forbidden',
            title: 'Invalid credentials',
            status: 403,
            code: 'INVALID_CREDENTIALS',
            detail: 'Current password does not match.',
          },
          { status: 403 },
        );
      }
    }

    // Update caller has_password
    const updatedUser: User = {
      ...caller,
      has_password: true,
    };
    for (const key of Object.keys(mockUsers)) {
      if (mockUsers[key].id === caller.id) {
        mockUsers[key] = updatedUser;
      }
    }
    if (currentUser?.id === caller.id) {
      currentUser = updatedUser;
    }

    return new HttpResponse(null, { status: 204 });
  }),

  http.delete('*/v1/auth/me', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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

    const body = (await request.json()) as DeleteMeRequest;
    if (!body.confirm_handle || body.confirm_handle.toLowerCase() !== caller.handle.toLowerCase()) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Confirmation mismatch',
          status: 400,
          code: 'CONFIRMATION_MISMATCH',
          detail: 'Confirm handle does not match your current handle.',
        },
        { status: 400 },
      );
    }

    if (caller.has_password) {
      if (!body.password || body.password === 'wrongpassword') {
        return HttpResponse.json(
          {
            type: '/problems/forbidden',
            title: 'Invalid credentials',
            status: 403,
            code: 'INVALID_CREDENTIALS',
            detail: 'Password does not match.',
          },
          { status: 403 },
        );
      }
    }

    // Check last admin
    if (caller.roles.includes('admin')) {
      const activeAdmins = dynamicAdminUsers.filter(
        (u) => u.roles.includes('admin') && u.status !== 'DELETED',
      );
      if (activeAdmins.length <= 1) {
        return HttpResponse.json(
          {
            type: '/problems/conflict',
            title: 'Last admin',
            status: 409,
            code: 'LAST_ADMIN',
            detail: 'You are the last admin; give the admin role to someone else first.',
          },
          { status: 409 },
        );
      }
    }

    // Soft delete
    const adminIdx = dynamicAdminUsers.findIndex((u) => u.id === caller.id);
    if (adminIdx !== -1) {
      dynamicAdminUsers[adminIdx] = {
        ...dynamicAdminUsers[adminIdx],
        status: 'DELETED',
      };
    }
    if (currentUser?.id === caller.id) {
      currentUser = null;
    }

    return new HttpResponse(null, {
      status: 204,
      headers: {
        'Set-Cookie': 'wk_rt=; HttpOnly; Path=/; Max-Age=0',
      },
    });
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
    const sort = url.searchParams.get('sort');
    const cursor = url.searchParams.get('cursor');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    if (ownerId && sort === 'trending') {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Invalid Sort',
          status: 400,
          code: 'INVALID_SORT',
          detail: 'owner_id cannot be combined with sort=trending',
        },
        { status: 400 },
      );
    }

    if (sort === 'trending') {
      const isTrendingEmpty =
        mockTrendingEmpty ||
        url.searchParams.get('mock_empty') === 'true' ||
        (typeof window !== 'undefined' &&
          window.sessionStorage?.getItem('wk_mock_trending_empty') === 'true');

      if (isTrendingEmpty) {
        return HttpResponse.json({ items: [], next_cursor: null } satisfies VideoPage, {
          headers: {
            'Cache-Control': 'public, max-age=60',
          },
        });
      }

      const allVideos = getDynamicVideos();
      const publicVideos = allVideos.filter(
        (v) => v.status === 'READY' && v.visibility === 'PUBLIC',
      );
      // Sort by view_count DESC, max 200 items total
      const trendingVideos = [...publicVideos]
        .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
        .slice(0, 200);

      const startIndex = cursor ? parseInt(cursor, 10) : 0;
      const items: VideoSummary[] = trendingVideos
        .slice(startIndex, startIndex + limit)
        .map((v) => ({
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
      const nextCursor = nextIndex < trendingVideos.length ? nextIndex.toString() : null;

      const page: VideoPage = {
        items,
        next_cursor: nextCursor,
      };

      return HttpResponse.json(page, {
        headers: {
          'Cache-Control': 'public, max-age=60',
        },
      });
    }

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

  http.get('*/v1/feed/subscriptions', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
      return HttpResponse.json(
        {
          type: '/problems/unauthorized',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
          detail: 'Authentication required to access subscription feed',
        },
        { status: 401 },
      );
    }

    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    const isSubEmpty =
      mockSubscriptionEmpty ||
      url.searchParams.get('mock_empty') === 'true' ||
      (typeof window !== 'undefined' &&
        window.sessionStorage?.getItem('wk_mock_subscriptions_empty') === 'true');

    if (isSubEmpty) {
      return HttpResponse.json({ items: [], next_cursor: null } satisfies VideoPage, {
        headers: {
          'Cache-Control': 'private, no-store',
        },
      });
    }

    if (mockSubscriptionVideosOverride !== null) {
      const startIndex = cursor ? parseInt(cursor, 10) : 0;
      const items = mockSubscriptionVideosOverride.slice(startIndex, startIndex + limit);
      const nextIndex = startIndex + limit;
      const nextCursor =
        nextIndex < mockSubscriptionVideosOverride.length ? nextIndex.toString() : null;
      return HttpResponse.json({ items, next_cursor: nextCursor } satisfies VideoPage, {
        headers: {
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const subs = getDynamicSubscriptions();
    const subscribedChannelIds = new Set<string>();
    for (const [chId, st] of subs.entries()) {
      if (st.subscribed) {
        subscribedChannelIds.add(chId);
      }
    }

    const allVideos = getDynamicVideos();
    let feedVideos: Video[] = [];
    if (subscribedChannelIds.size > 0) {
      feedVideos = allVideos.filter(
        (v) =>
          v.status === 'READY' && v.visibility === 'PUBLIC' && subscribedChannelIds.has(v.owner.id),
      );
    }

    // Sort newest first: published_at DESC, id DESC
    feedVideos.sort((a, b) => {
      const timeA = new Date(a.published_at || a.created_at).getTime();
      const timeB = new Date(b.published_at || b.created_at).getTime();
      if (timeB !== timeA) return timeB - timeA;
      return b.id.localeCompare(a.id);
    });

    const startIndex = cursor ? parseInt(cursor, 10) : 0;
    const items: VideoSummary[] = feedVideos.slice(startIndex, startIndex + limit).map((v) => ({
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
    const nextCursor = nextIndex < feedVideos.length ? nextIndex.toString() : null;

    const page: VideoPage = {
      items,
      next_cursor: nextCursor,
    };

    return HttpResponse.json(page, {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    });
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

  // --- SUBTITLES & STORYBOARD ENDPOINTS (Task U7) ---
  http.put('*/v1/videos/:id/subtitles/:lang', async ({ params, request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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

    const videoId = params.id as string;
    const lang = params.lang as string;
    const body = (await request.json()) as PutSubtitleRequest;

    // Check size limit: max 524288 bytes
    if (body.content && new TextEncoder().encode(body.content).length > 524288) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Subtitle too large',
          status: 400,
          code: 'SUBTITLE_TOO_LARGE',
          detail: 'Subtitle file exceeds 524288 bytes',
        },
        { status: 400 },
      );
    }

    // Check WebVTT validity: starts with WEBVTT
    const cleanContent = (body.content || '').replace(/^\uFEFF/, '').trim();
    if (!cleanContent.startsWith('WEBVTT')) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Invalid WebVTT',
          status: 400,
          code: 'INVALID_WEBVTT',
          detail: 'First line must be WEBVTT (line 1)',
        },
        { status: 400 },
      );
    }

    const currentVideos = [...getDynamicVideos()];
    const videoIndex = currentVideos.findIndex((v) => v.id === videoId);
    if (videoIndex === -1) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Video not found', status: 404, code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const video = currentVideos[videoIndex];
    if (video.owner.id !== caller.id) {
      return HttpResponse.json(
        { type: '/problems/forbidden', title: 'Forbidden', status: 403, code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    if (video.status === 'FAILED') {
      return HttpResponse.json(
        {
          type: '/problems/conflict',
          title: 'Video failed',
          status: 409,
          code: 'VIDEO_FAILED',
          detail: 'Cannot add subtitles to a failed video',
        },
        { status: 409 },
      );
    }

    const currentSubtitles = [...(video.playback?.subtitles || [])];
    const existingIndex = currentSubtitles.findIndex((t) => t.lang === lang);

    if (existingIndex === -1 && currentSubtitles.length >= 20) {
      return HttpResponse.json(
        {
          type: '/problems/conflict',
          title: 'Too many subtitles',
          status: 409,
          code: 'TOO_MANY_SUBTITLES',
          detail: 'Maximum 20 subtitle tracks per video',
        },
        { status: 409 },
      );
    }

    const track: SubtitleTrack = {
      lang,
      label: body.label || lang,
      source: 'UPLOAD',
      url: `/v1/mock-subtitles/${videoId}/${lang}.vtt`,
      updated_at: new Date().toISOString(),
    };

    let status = 200;
    if (existingIndex !== -1) {
      currentSubtitles[existingIndex] = track;
    } else {
      currentSubtitles.push(track);
      status = 201;
    }

    if (video.playback) {
      video.playback = {
        ...video.playback,
        subtitles: currentSubtitles,
      };
    }

    currentVideos[videoIndex] = video;
    setDynamicVideos(currentVideos);

    return HttpResponse.json(track, { status });
  }),

  http.delete('*/v1/videos/:id/subtitles/:lang', async ({ params, request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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

    const videoId = params.id as string;
    const lang = params.lang as string;

    const currentVideos = [...getDynamicVideos()];
    const videoIndex = currentVideos.findIndex((v) => v.id === videoId);
    if (videoIndex === -1) {
      return HttpResponse.json(
        { type: '/problems/not-found', title: 'Video not found', status: 404, code: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    const video = currentVideos[videoIndex];
    if (video.owner.id !== caller.id) {
      return HttpResponse.json(
        { type: '/problems/forbidden', title: 'Forbidden', status: 403, code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    const currentSubtitles = [...(video.playback?.subtitles || [])];
    const trackIndex = currentSubtitles.findIndex((t) => t.lang === lang);
    if (trackIndex === -1) {
      return HttpResponse.json(
        {
          type: '/problems/not-found',
          title: 'Subtitle track not found',
          status: 404,
          code: 'NOT_FOUND',
        },
        { status: 404 },
      );
    }

    currentSubtitles.splice(trackIndex, 1);
    if (video.playback) {
      video.playback = {
        ...video.playback,
        subtitles: currentSubtitles,
      };
    }

    currentVideos[videoIndex] = video;
    setDynamicVideos(currentVideos);

    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/v1/mock-subtitles/:id/:file', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
Chào mừng các bạn đến với Winkey VN!

00:00:05.000 --> 00:00:10.000
Hôm nay chúng ta sẽ tìm hiểu kiến trúc phân tán.
`;
    return new HttpResponse(vtt, {
      status: 200,
      headers: { 'Content-Type': 'text/vtt; charset=utf-8' },
    });
  }),

  http.get('*/v1/mock-storyboard/:id/storyboard.vtt', () => {
    let vtt = 'WEBVTT\n\n';
    for (let t = 0; t < 1500; t += 5) {
      const start = new Date(t * 1000).toISOString().slice(11, 23);
      const end = new Date((t + 5) * 1000).toISOString().slice(11, 23);
      const col = (t / 5) % 5;
      const row = Math.floor(t / 5 / 5) % 5;
      vtt += `${start} --> ${end}\nsprites_0.jpg#xywh=${col * 160},${row * 90},160,90\n\n`;
    }
    return new HttpResponse(vtt, {
      status: 200,
      headers: { 'Content-Type': 'text/vtt; charset=utf-8' },
    });
  }),

  http.get('*/v1/mock-storyboard/:id/:file', () => {
    const mockPixel = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const binary = Uint8Array.from(atob(mockPixel), (c) => c.charCodeAt(0));
    return new HttpResponse(binary, {
      status: 200,
      headers: { 'Content-Type': 'image/gif' },
    });
  }),

  // --- PLAYBACK HEARTBEATS ENDPOINT (Task U8) ---
  http.post('*/v1/playback/heartbeats', async ({ request }) => {
    if (mockHeartbeat429) {
      return HttpResponse.json(
        {
          type: '/problems/too-many-requests',
          title: 'Too Many Requests',
          status: 429,
          code: 'TOO_MANY_REQUESTS',
          detail: 'Heartbeat rate limit exceeded',
        },
        { status: 429 },
      );
    }

    const rawText = await request.text();
    // Limits: body <= 16 KiB (16384 bytes)
    if (new TextEncoder().encode(rawText).length > 16384) {
      return HttpResponse.json(
        {
          type: '/problems/payload-too-large',
          title: 'Payload Too Large',
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          detail: 'Body exceeds 16 KiB',
        },
        { status: 413 },
      );
    }

    let body: PlaybackHeartbeatBatch;
    try {
      body = JSON.parse(rawText) as PlaybackHeartbeatBatch;
    } catch {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Bad Request',
          status: 400,
          code: 'BAD_REQUEST',
          detail: 'Invalid JSON body',
        },
        { status: 400 },
      );
    }

    if (
      !body ||
      !Array.isArray(body.samples) ||
      body.samples.length === 0 ||
      body.samples.length > 20
    ) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Bad Request',
          status: 400,
          code: 'BAD_REQUEST',
          detail: 'Samples array must contain between 1 and 20 items',
        },
        { status: 400 },
      );
    }

    mockRecordedHeartbeats.push(...body.samples);

    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        const existing = JSON.parse(window.sessionStorage.getItem('wk_mock_heartbeats') || '[]');
        existing.push(...body.samples);
        window.sessionStorage.setItem('wk_mock_heartbeats', JSON.stringify(existing));
      } catch {
        // ignore
      }
    }

    const result: PlaybackHeartbeatResult = {
      accepted: body.samples.length,
    };
    return HttpResponse.json(result, { status: 202 });
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

  // --- Realtime: Ticket ---
  http.post('*/v1/realtime/ticket', async () => {
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
    return HttpResponse.json(
      {
        ticket: `mock-ticket-${Date.now()}`,
        expires_in: 30,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  }),

  // --- Task U4: Reporting ---
  http.post('*/v1/reports', async ({ request }) => {
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
    const body = (await request.json()) as {
      target_type: ReportTargetType;
      target_id: string;
      reason: ReportReason;
      note?: string;
    };

    // Check self-reporting
    const isSelfVideo =
      body.target_type === 'VIDEO' &&
      dynamicVideos.find((v) => v.id === body.target_id)?.owner.id === currentUser.id;
    const isSelfComment =
      body.target_type === 'COMMENT' &&
      dynamicComments.find((c) => c.id === body.target_id)?.author?.id === currentUser.id;
    const isSelfUser = body.target_type === 'USER' && body.target_id === currentUser.id;

    if (isSelfVideo || isSelfComment || isSelfUser) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Cannot report self',
          status: 400,
          code: 'CANNOT_REPORT_SELF',
          detail: 'You cannot report your own content.',
        },
        { status: 400 },
      );
    }

    if (
      body.target_id === 'already-reported-target-id' ||
      body.note?.includes('already-reported')
    ) {
      const receipt: ReportReceipt = {
        id: '0192f5e4-already-reported-id',
        created_at: '2026-09-28T10:00:00Z',
      };
      return HttpResponse.json(receipt, { status: 200 });
    }

    const receipt: ReportReceipt = {
      id: `mock-report-${Date.now()}`,
      created_at: new Date().toISOString(),
    };
    return HttpResponse.json(receipt, { status: 201 });
  }),

  // --- Task U4: Moderation Queue ---
  http.get('*/v1/moderation/reports', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller || (!caller.roles.includes('moderator') && !caller.roles.includes('admin'))) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status') as ReportStatus | null;
    const targetTypeParam = url.searchParams.get('target_type');

    let items = [...dynamicModerationCases];
    if (statusParam) {
      items = items.filter((c) => c.status === statusParam);
    }
    if (targetTypeParam && targetTypeParam !== 'ALL') {
      items = items.filter((c) => c.target_type === targetTypeParam);
    }

    const page: ModerationCasePage = {
      items,
      next_cursor: null,
    };
    return HttpResponse.json(page);
  }),

  http.put(
    '*/v1/moderation/cases/:target_type/:target_id/resolution',
    async ({ params, request }) => {
      const caller = callerFromRequest(request);
      if (!caller || (!caller.roles.includes('moderator') && !caller.roles.includes('admin'))) {
        return HttpResponse.json(
          {
            type: '/problems/forbidden',
            title: 'Forbidden',
            status: 403,
            code: 'FORBIDDEN',
          },
          { status: 403 },
        );
      }
      const targetType = params.target_type as ReportTargetType;
      const targetId = params.target_id as string;
      const body = (await request.json()) as { status: 'ACTIONED' | 'DISMISSED'; note?: string };

      if (targetId === 'fail-resolution-id') {
        return HttpResponse.json(
          {
            type: '/problems/conflict',
            title: 'Case resolution failed',
            status: 409,
            code: 'RESOLUTION_ERROR',
            detail: 'Database error closing case.',
          },
          { status: 409 },
        );
      }

      const caseIndex = dynamicModerationCases.findIndex(
        (c) => c.target_type === targetType && c.target_id === targetId,
      );
      if (caseIndex !== -1) {
        dynamicModerationCases[caseIndex] = {
          ...dynamicModerationCases[caseIndex],
          status: body.status,
          resolution: {
            resolved_by: caller.id,
            note: body.note || null,
            resolved_at: new Date().toISOString(),
          },
        };
      }

      const result: ResolveCaseResult = { resolved_count: 1 };
      return HttpResponse.json(result);
    },
  ),

  http.put('*/v1/videos/:id/moderation', async ({ params, request }) => {
    const caller = callerFromRequest(request);
    if (!caller || (!caller.roles.includes('moderator') && !caller.roles.includes('admin'))) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const videoId = params.id as string;
    const body = (await request.json()) as { state: 'VISIBLE' | 'HIDDEN'; reason?: string };

    if (body.state === 'HIDDEN' && !body.reason) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Reason required',
          status: 400,
          code: 'BAD_REQUEST',
          detail: 'Reason is required when hiding video.',
        },
        { status: 400 },
      );
    }

    const videoIndex = dynamicVideos.findIndex((v) => v.id === videoId);
    if (videoIndex === -1) {
      return HttpResponse.json(
        {
          type: '/problems/not-found',
          title: 'Video not found',
          status: 404,
          code: 'NOT_FOUND',
        },
        { status: 404 },
      );
    }

    dynamicVideos[videoIndex] = {
      ...dynamicVideos[videoIndex],
      moderation: {
        state: body.state,
        reason: body.state === 'HIDDEN' ? body.reason || null : null,
        moderated_at: new Date().toISOString(),
      },
      visibility: body.state === 'HIDDEN' ? 'PRIVATE' : dynamicVideos[videoIndex].visibility,
    };

    const studioIdx = dynamicStudioVideos.findIndex((v) => v.id === videoId);
    if (studioIdx !== -1) {
      dynamicStudioVideos[studioIdx] = {
        ...dynamicStudioVideos[studioIdx],
        moderation: {
          state: body.state,
          reason: body.state === 'HIDDEN' ? body.reason || null : null,
          moderated_at: new Date().toISOString(),
        },
      };
    }

    return HttpResponse.json(dynamicVideos[videoIndex]);
  }),

  http.put('*/v1/comments/:id/moderation', async ({ params, request }) => {
    const caller = callerFromRequest(request);
    if (!caller || (!caller.roles.includes('moderator') && !caller.roles.includes('admin'))) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const commentId = params.id as string;
    const body = (await request.json()) as { status: 'VISIBLE' | 'HIDDEN' };

    const commentIndex = dynamicComments.findIndex((c) => c.id === commentId);
    if (commentIndex === -1) {
      return HttpResponse.json(
        {
          type: '/problems/not-found',
          title: 'Comment not found',
          status: 404,
          code: 'NOT_FOUND',
        },
        { status: 404 },
      );
    }

    if (dynamicComments[commentIndex].status === 'DELETED') {
      return HttpResponse.json(
        {
          type: '/problems/conflict',
          title: 'Comment deleted',
          status: 409,
          code: 'DELETED',
        },
        { status: 409 },
      );
    }

    dynamicComments[commentIndex] = {
      ...dynamicComments[commentIndex],
      status: body.status,
    };

    return HttpResponse.json(dynamicComments[commentIndex]);
  }),

  // --- Task U4: Admin Users Management ---
  http.get('*/v1/admin/users', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller || (!caller.roles.includes('moderator') && !caller.roles.includes('admin'))) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.toLowerCase();
    const role = url.searchParams.get('role') as Role | null;
    const status = url.searchParams.get('status') as UserStatus | null;

    let items = [...dynamicAdminUsers];
    if (q && q.length >= 2) {
      items = items.filter(
        (u) =>
          u.email.toLowerCase().includes(q) ||
          u.handle.toLowerCase().includes(q) ||
          u.display_name.toLowerCase().includes(q),
      );
    }
    if (role) {
      items = items.filter((u) => u.roles.includes(role));
    }
    if (status) {
      items = items.filter((u) => u.status === status);
    }

    const page: AdminUserPage = { items, next_cursor: null };
    return HttpResponse.json(page);
  }),

  http.get('*/v1/admin/users/:id', async ({ params, request }) => {
    const caller = callerFromRequest(request);
    if (!caller || (!caller.roles.includes('moderator') && !caller.roles.includes('admin'))) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const user = dynamicAdminUsers.find((u) => u.id === params.id);
    if (!user) {
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
    return HttpResponse.json(user);
  }),

  http.put('*/v1/admin/users/:id/roles', async ({ params, request }) => {
    const caller = callerFromRequest(request);
    if (!caller || !caller.roles.includes('admin')) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Admin only',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const targetId = params.id as string;
    if (caller.id === targetId) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Cannot moderate target',
          status: 403,
          code: 'CANNOT_MODERATE_TARGET',
          detail: 'Cannot change your own roles.',
        },
        { status: 403 },
      );
    }

    const body = (await request.json()) as { roles: Role[] };
    const userIndex = dynamicAdminUsers.findIndex((u) => u.id === targetId);
    if (userIndex === -1) {
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

    if (dynamicAdminUsers[userIndex].status === 'DELETED') {
      return HttpResponse.json(
        {
          type: '/problems/conflict',
          title: 'User deleted',
          status: 409,
          code: 'DELETED',
          detail: 'User account has been deleted.',
        },
        { status: 409 },
      );
    }

    // Check LAST_ADMIN
    const currentAdmins = dynamicAdminUsers.filter(
      (u) => u.status !== 'DELETED' && u.roles.includes('admin'),
    );
    if (
      currentAdmins.length === 1 &&
      currentAdmins[0].id === targetId &&
      !body.roles.includes('admin')
    ) {
      return HttpResponse.json(
        {
          type: '/problems/conflict',
          title: 'Cannot remove last admin',
          status: 409,
          code: 'LAST_ADMIN',
          detail: 'Cannot remove admin role from the last system administrator.',
        },
        { status: 409 },
      );
    }

    const oldRoles = dynamicAdminUsers[userIndex].roles;
    const newRoles = body.roles.includes('viewer') ? body.roles : ['viewer' as Role, ...body.roles];
    dynamicAdminUsers[userIndex] = {
      ...dynamicAdminUsers[userIndex],
      roles: newRoles,
    };

    dynamicAuditEntries.unshift({
      id: `audit-${Date.now()}`,
      actor: {
        id: caller.id,
        handle: caller.handle,
        display_name: caller.display_name,
        avatar_url: caller.avatar_url,
      },
      action: 'USER_ROLES_CHANGED',
      target_user_id: targetId,
      details: { from: oldRoles, to: newRoles },
      created_at: new Date().toISOString(),
    });

    return HttpResponse.json(dynamicAdminUsers[userIndex]);
  }),

  http.put('*/v1/admin/users/:id/suspension', async ({ params, request }) => {
    const caller = callerFromRequest(request);
    if (!caller || (!caller.roles.includes('moderator') && !caller.roles.includes('admin'))) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const targetId = params.id as string;
    if (caller.id === targetId) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Cannot moderate self',
          status: 403,
          code: 'CANNOT_MODERATE_TARGET',
          detail: 'Cannot suspend your own account.',
        },
        { status: 403 },
      );
    }

    const userIndex = dynamicAdminUsers.findIndex((u) => u.id === targetId);
    if (userIndex === -1) {
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

    const target = dynamicAdminUsers[userIndex];
    if (target.status === 'DELETED') {
      return HttpResponse.json(
        {
          type: '/problems/conflict',
          title: 'User deleted',
          status: 409,
          code: 'DELETED',
          detail: 'User account has been deleted.',
        },
        { status: 409 },
      );
    }

    if (target.roles.includes('admin')) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Cannot moderate admin',
          status: 403,
          code: 'CANNOT_MODERATE_TARGET',
          detail: 'Cannot suspend an administrator.',
        },
        { status: 403 },
      );
    }

    if (!caller.roles.includes('admin') && target.roles.includes('moderator')) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Cannot moderate moderator',
          status: 403,
          code: 'CANNOT_MODERATE_TARGET',
          detail: 'Moderators cannot suspend other moderators.',
        },
        { status: 403 },
      );
    }

    const body = (await request.json()) as { reason: string; until?: string };
    if (!body.reason) {
      return HttpResponse.json(
        {
          type: '/problems/bad-request',
          title: 'Reason required',
          status: 400,
          code: 'BAD_REQUEST',
        },
        { status: 400 },
      );
    }

    dynamicAdminUsers[userIndex] = {
      ...target,
      status: 'SUSPENDED',
      suspension_reason: body.reason,
      suspended_until: body.until || null,
    };

    dynamicAuditEntries.unshift({
      id: `audit-${Date.now()}`,
      actor: {
        id: caller.id,
        handle: caller.handle,
        display_name: caller.display_name,
        avatar_url: caller.avatar_url,
      },
      action: 'USER_SUSPENDED',
      target_user_id: targetId,
      details: { reason: body.reason, until: body.until || null },
      created_at: new Date().toISOString(),
    });

    return HttpResponse.json(dynamicAdminUsers[userIndex]);
  }),

  http.delete('*/v1/admin/users/:id/suspension', async ({ params, request }) => {
    const caller = callerFromRequest(request);
    if (!caller || (!caller.roles.includes('moderator') && !caller.roles.includes('admin'))) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const targetId = params.id as string;
    if (caller.id === targetId) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Cannot moderate self',
          status: 403,
          code: 'CANNOT_MODERATE_TARGET',
        },
        { status: 403 },
      );
    }

    const userIndex = dynamicAdminUsers.findIndex((u) => u.id === targetId);
    if (userIndex === -1) {
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

    const target = dynamicAdminUsers[userIndex];
    if (target.status === 'DELETED') {
      return HttpResponse.json(
        {
          type: '/problems/conflict',
          title: 'User deleted',
          status: 409,
          code: 'DELETED',
        },
        { status: 409 },
      );
    }

    if (target.roles.includes('admin')) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Cannot moderate admin',
          status: 403,
          code: 'CANNOT_MODERATE_TARGET',
        },
        { status: 403 },
      );
    }

    if (!caller.roles.includes('admin') && target.roles.includes('moderator')) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Cannot moderate moderator',
          status: 403,
          code: 'CANNOT_MODERATE_TARGET',
        },
        { status: 403 },
      );
    }

    dynamicAdminUsers[userIndex] = {
      ...target,
      status: 'ACTIVE',
      suspension_reason: null,
      suspended_until: null,
    };

    dynamicAuditEntries.unshift({
      id: `audit-${Date.now()}`,
      actor: {
        id: caller.id,
        handle: caller.handle,
        display_name: caller.display_name,
        avatar_url: caller.avatar_url,
      },
      action: 'USER_UNSUSPENDED',
      target_user_id: targetId,
      details: {},
      created_at: new Date().toISOString(),
    });

    return HttpResponse.json(dynamicAdminUsers[userIndex]);
  }),

  // --- Task U4: Audit Log ---
  http.get('*/v1/admin/audit-log', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller || !caller.roles.includes('admin')) {
      return HttpResponse.json(
        {
          type: '/problems/forbidden',
          title: 'Admin only',
          status: 403,
          code: 'FORBIDDEN',
        },
        { status: 403 },
      );
    }
    const url = new URL(request.url);
    const targetUserId = url.searchParams.get('target_user_id');

    let items = [...dynamicAuditEntries];
    if (targetUserId) {
      items = items.filter((a) => a.target_user_id === targetUserId);
    }

    const page: AuditEntryPage = { items, next_cursor: null };
    return HttpResponse.json(page);
  }),

  // --- Task N1: Notifications (ADR-023) ---
  http.get('*/v1/notifications/unread-count', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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
    if (mockNotificationsEmpty) {
      return HttpResponse.json({ count: 0, capped: false });
    }
    if (mockNotificationsCapped) {
      return HttpResponse.json({ count: 101, capped: true });
    }
    const unread = dynamicNotifications.filter((n) => !n.read_at);
    if (unread.length > 100) {
      return HttpResponse.json({ count: 100, capped: true });
    }
    return HttpResponse.json({ count: unread.length, capped: false });
  }),

  http.get('*/v1/notifications', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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
    if (mockNotificationsEmpty) {
      const page: NotificationPage = { items: [], next_cursor: null };
      return HttpResponse.json(page);
    }
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get('unread') === 'true';
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
    const cursor = url.searchParams.get('cursor');

    let filtered = dynamicNotifications;
    if (unreadOnly) {
      filtered = filtered.filter((n) => !n.read_at);
    }

    let startIndex = 0;
    if (cursor) {
      const cursorIndex = filtered.findIndex((n) => n.id === cursor);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      }
    }

    const items = filtered.slice(startIndex, startIndex + limit);
    const nextItem = filtered[startIndex + limit];
    const nextCursor = nextItem ? nextItem.id : null;

    const page: NotificationPage = { items, next_cursor: nextCursor };
    return HttpResponse.json(page);
  }),

  http.post('*/v1/notifications/read', async ({ request }) => {
    const caller = callerFromRequest(request);
    if (!caller) {
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
    if (mockNotificationsError) {
      return HttpResponse.json(
        {
          type: '/problems/internal',
          title: 'Internal Server Error',
          status: 500,
          code: 'INTERNAL_ERROR',
        },
        { status: 500 },
      );
    }
    const body = (await request.json()) as MarkNotificationsReadRequest;
    const now = new Date().toISOString();

    if (body.ids && body.ids.length > 0) {
      const idSet = new Set(body.ids);
      dynamicNotifications = dynamicNotifications.map((n) =>
        idSet.has(n.id) && !n.read_at ? { ...n, read_at: now } : n,
      );
    } else if (body.up_to) {
      const upToTime = new Date(body.up_to).getTime();
      dynamicNotifications = dynamicNotifications.map((n) =>
        new Date(n.created_at).getTime() <= upToTime && !n.read_at ? { ...n, read_at: now } : n,
      );
    }

    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/v1/test/reset-notifications', async () => {
    resetNotificationMocks();
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/v1/test/add-notification', async () => {
    const newNotif: Notification = {
      id: `0192f5e4-9000-7000-8000-${Date.now().toString(16).padStart(12, '0')}`,
      kind: 'VIDEO_COMMENT',
      actor: {
        id: '018f3a22-7f91-7d9a-9e12-111111111111',
        handle: 'fan123',
        display_name: 'Fan 123',
        avatar_url: null,
      },
      video_id: '018f3a22-7f91-7d9a-9e12-000000000001',
      comment_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
      created_at: new Date().toISOString(),
      read_at: null,
    };
    dynamicNotifications.unshift(newNotif);
    return HttpResponse.json(newNotif, { status: 201 });
  }),
];
