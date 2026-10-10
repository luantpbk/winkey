import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VideoEditView } from '../src/components/studio/video-edit-view';
import StudioPage from '../src/app/[locale]/studio/page';
import { WatchClientSection } from '../src/app/[locale]/watch/[id]/watch-client';
import { api } from '../src/lib/api-client';
import type { Video, StudioVideoPage } from '@winkey/api-client';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

// --- Locale Mock ---
let activeLocale: 'vi' | 'en' = 'vi';
export function setTestLocale(locale: 'vi' | 'en') {
  activeLocale = locale;
}

// Mock next-intl
const translatorMap = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const nsKey = `${activeLocale}:${namespace ?? ''}`;
    let fn = translatorMap.get(nsKey);
    if (!fn) {
      fn = (key: string, values?: Record<string, unknown>) => {
        const isVi = activeLocale === 'vi';
        const fullPath = namespace ? `${namespace}.${key}` : key;
        const parts = fullPath.split('.');
        let cur: unknown = isVi ? viMessages : enMessages;
        for (const p of parts) {
          if (cur && typeof cur === 'object' && p in cur) {
            cur = (cur as Record<string, unknown>)[p];
          } else {
            return key;
          }
        }
        if (typeof cur === 'string') {
          let res = cur;
          if (values) {
            for (const [k, v] of Object.entries(values)) {
              res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
          }
          return res;
        }
        return key;
      };
      translatorMap.set(nsKey, fn);
    }
    return fn;
  },
}));

// Mock navigation
const mockPush = vi.fn();
const mockParamsId = '018f1234-5678-7000-8000-000000000001';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: mockParamsId, locale: activeLocale }),
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/studio/videos/${mockParamsId}/edit`,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../src/i18n/routing', () => ({
  Link: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => `/studio/videos/${mockParamsId}/edit`,
  useRouter: () => ({ push: mockPush }),
}));

// Mock api
vi.mock('../src/lib/api-client', () => ({
  api: {
    video: {
      GET: vi.fn(),
      PATCH: vi.fn(),
      DELETE: vi.fn(),
    },
    social: {
      GET: vi.fn(),
      POST: vi.fn(),
      DELETE: vi.fn(),
    },
  },
}));

// Mock toast
const mockShowToast = vi.fn();
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

// Mock auth
let mockCurrentUser: { id: string; display_name: string; handle: string; roles: string[] } | null =
  {
    id: 'user-1',
    display_name: 'Owner User',
    handle: 'owner',
    roles: ['CREATOR'],
  };

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockCurrentUser,
    isAuthenticated: !!mockCurrentUser,
    isLoading: false,
  }),
}));

// Mock realtime
vi.mock('../src/lib/realtime/realtime-context', () => ({
  useRealtime: () => ({
    client: { subscribe: vi.fn(() => () => {}) },
    isConnected: true,
  }),
  useRealtimeRoom: () => vi.fn(),
}));

const mockVideo: Video = {
  id: mockParamsId,
  title: 'Original Title Video',
  description: 'Original Description Here',
  status: 'READY',
  duration_ms: 125000,
  visibility: 'PRIVATE',
  tags: ['tutorial', 'coding'],
  width: 1920,
  height: 1080,
  view_count: 50,
  like_count: 5,
  published_at: '2026-09-30T10:00:00Z',
  created_at: '2026-09-30T10:00:00Z',
  owner: {
    id: 'user-1',
    handle: 'owner',
    display_name: 'Owner User',
    avatar_url: null,
  },
  playback: {
    hls_url: 'https://cdn.winkey.vn/hls/test/master.m3u8',
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/test.jpg',
    renditions: [],
    subtitles: [],
  },
};

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('Studio Edit Video (Task ST1-web)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTestLocale('vi');
    mockCurrentUser = {
      id: 'user-1',
      display_name: 'Owner User',
      handle: 'owner',
      roles: ['CREATOR'],
    };

    vi.mocked(api.video.GET).mockImplementation(async (path: string) => {
      if (path === '/v1/videos/{video_id}') {
        return {
          data: { ...mockVideo },
          response: new Response(null, { status: 200 }),
        } as any;
      }
      if (path === '/v1/studio/videos') {
        const studioPage: StudioVideoPage = {
          items: [
            {
              id: mockVideo.id,
              title: mockVideo.title,
              status: mockVideo.status,
              visibility: mockVideo.visibility,
              duration_ms: mockVideo.duration_ms,
              created_at: mockVideo.created_at,
              progress: 100,
              error: null,
              thumbnail_url: null,
            },
          ],
          next_cursor: null,
        };
        return {
          data: studioPage,
          response: new Response(null, { status: 200 }),
        } as any;
      }
      return { response: new Response(null, { status: 404 }) } as any;
    });

    vi.mocked(api.video.PATCH).mockResolvedValue({
      data: { ...mockVideo },
      response: new Response(null, { status: 200 }),
    } as any);
  });

  it('renders form with video data and disables save button when nothing changed', async () => {
    renderWithClient(<VideoEditView />);

    await waitFor(() => {
      const titleInput = screen.getByTestId('video-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Original Title Video');
    });

    const descInput = screen.getByTestId('video-description-input') as HTMLTextAreaElement;
    expect(descInput.value).toBe('Original Description Here');
    expect(screen.getByTestId('title-counter').textContent).toBe('20/100');
    expect(screen.getByTestId('description-counter').textContent).toBe('25/5000');
    expect(screen.getByTestId('tags-helper-text').textContent).toContain(
      'Thẻ giúp người xem tìm video trong Winkey.',
    );

    // Initial tags are shown
    expect(screen.getByTestId('tag-chip-0').textContent).toContain('tutorial');
    expect(screen.getByTestId('tag-chip-1').textContent).toContain('coding');

    // Read-only preview
    expect(screen.getByTestId('preview-thumbnail')).toBeTruthy();
    expect(screen.getByTestId('preview-duration').textContent).toBe('2:05');
    expect(screen.getByTestId('preview-status').textContent).toContain('Sẵn sàng');

    // Button disabled when not dirty
    const saveBtn = screen.getByTestId('save-video-changes-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('sends ONLY changed fields in PATCH request when editing title', async () => {
    renderWithClient(<VideoEditView />);

    await waitFor(() => {
      const titleInput = screen.getByTestId('video-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Original Title Video');
    });

    const titleInput = screen.getByTestId('video-title-input');
    fireEvent.change(titleInput, { target: { value: 'Updated Video Title' } });

    const saveBtn = screen.getByTestId('save-video-changes-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.video.PATCH).toHaveBeenCalledTimes(1);
    });

    expect(api.video.PATCH).toHaveBeenCalledWith(
      '/v1/videos/{video_id}',
      expect.objectContaining({
        params: { path: { video_id: mockParamsId } },
        body: {
          title: 'Updated Video Title',
          // description, visibility, and tags must NOT be sent!
        },
      }),
    );

    expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('sends ONLY visibility when visibility changes to PUBLIC', async () => {
    renderWithClient(<VideoEditView />);

    await waitFor(() => {
      const titleInput = screen.getByTestId('video-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Original Title Video');
    });

    const publicOption = screen.getByTestId('visibility-radio-PUBLIC');
    fireEvent.click(publicOption);

    const saveBtn = screen.getByTestId('save-video-changes-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.video.PATCH).toHaveBeenCalledTimes(1);
    });

    expect(api.video.PATCH).toHaveBeenCalledWith(
      '/v1/videos/{video_id}',
      expect.objectContaining({
        params: { path: { video_id: mockParamsId } },
        body: {
          visibility: 'PUBLIC',
        },
      }),
    );
  });

  it('handles tag chip additions, removals, and sends tags array', async () => {
    renderWithClient(<VideoEditView />);

    await waitFor(() => {
      expect(screen.getByTestId('tag-chip-0').textContent).toContain('tutorial');
    });

    // Remove first tag
    const removeBtn = screen.getByTestId('remove-tag-0');
    fireEvent.click(removeBtn);

    expect(screen.queryByText('tutorial')).toBeNull();

    // Add new tag with Enter
    const tagInput = screen.getByTestId('tag-input');
    fireEvent.change(tagInput, { target: { value: 'nextjs' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });

    expect(screen.getByText('nextjs')).toBeTruthy();

    // Add another tag with comma
    fireEvent.change(tagInput, { target: { value: 'typescript' } });
    fireEvent.keyDown(tagInput, { key: ',' });

    expect(screen.getByText('typescript')).toBeTruthy();

    const saveBtn = screen.getByTestId('save-video-changes-btn');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.video.PATCH).toHaveBeenCalledTimes(1);
    });

    expect(api.video.PATCH).toHaveBeenCalledWith(
      '/v1/videos/{video_id}',
      expect.objectContaining({
        body: {
          tags: ['coding', 'nextjs', 'typescript'],
        },
      }),
    );
  });

  it('displays field errors on 400 Bad Request response', async () => {
    vi.mocked(api.video.PATCH).mockResolvedValue({
      response: new Response(null, { status: 400 }),
      error: {
        type: '/problems/validation-error',
        title: 'Validation failed',
        status: 400,
        code: 'VALIDATION_ERROR',
        errors: [
          { field: 'title', message: 'must be 1-100 characters' },
          { field: 'tags', message: 'at most 10 tags' },
        ],
      },
    } as any);

    renderWithClient(<VideoEditView />);

    await waitFor(() => {
      const titleInput = screen.getByTestId('video-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Original Title Video');
    });

    fireEvent.change(screen.getByTestId('video-title-input'), { target: { value: 'New Title' } });
    fireEvent.click(screen.getByTestId('save-video-changes-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('title-error').textContent).toContain('must be 1-100 characters');
      expect(screen.getByTestId('tags-error').textContent).toContain('at most 10 tags');
    });
  });

  it('displays 403 Forbidden message "Bạn không có quyền sửa video này."', async () => {
    vi.mocked(api.video.PATCH).mockResolvedValue({
      response: new Response(null, { status: 403 }),
      error: {
        type: '/problems/forbidden',
        title: 'Forbidden',
        status: 403,
        code: 'FORBIDDEN',
        detail: 'only the owner can edit this video',
      },
    } as any);

    renderWithClient(<VideoEditView />);

    await waitFor(() => {
      const titleInput = screen.getByTestId('video-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Original Title Video');
    });

    fireEvent.change(screen.getByTestId('video-title-input'), { target: { value: 'New Title' } });
    fireEvent.click(screen.getByTestId('save-video-changes-btn'));

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Bạn không có quyền sửa video này.',
          type: 'error',
        }),
      );
    });
  });

  it('warns on beforeunload when form has unsaved changes', async () => {
    renderWithClient(<VideoEditView />);

    await waitFor(() => {
      const titleInput = screen.getByTestId('video-title-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Original Title Video');
    });

    // Make dirty
    fireEvent.change(screen.getByTestId('video-title-input'), {
      target: { value: 'Modified Title' },
    });

    const beforeUnloadEvent = new Event('beforeunload', { cancelable: true });
    const preventDefaultSpy = vi.spyOn(beforeUnloadEvent, 'preventDefault');

    window.dispatchEvent(beforeUnloadEvent);
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it('renders "Chỉnh sửa" button on watch page only for the video owner', async () => {
    // Owner view
    mockCurrentUser = {
      id: 'user-1',
      display_name: 'Owner User',
      handle: 'owner',
      roles: ['CREATOR'],
    };

    const { unmount } = renderWithClient(<WatchClientSection video={mockVideo} />);
    const editBtn = screen.getByTestId('owner-edit-video-btn');
    expect(editBtn).toBeTruthy();
    expect(editBtn.getAttribute('href')).toBe(`/studio/videos/${mockVideo.id}/edit`);

    unmount();

    // Non-owner view
    mockCurrentUser = {
      id: 'user-2',
      display_name: 'Other Viewer',
      handle: 'other',
      roles: ['USER'],
    };

    renderWithClient(<WatchClientSection video={mockVideo} />);
    expect(screen.queryByTestId('owner-edit-video-btn')).toBeNull();
  });

  it('renders "Sửa" link and "Thêm vào danh sách" button in Studio video list table', async () => {
    renderWithClient(<StudioPage />);

    await waitFor(() => {
      expect(screen.getByTestId(`edit-video-${mockVideo.id}`)).toBeTruthy();
    });

    const editLink = screen.getByTestId(`edit-video-${mockVideo.id}`);
    expect(editLink.getAttribute('href')).toBe(`/studio/videos/${mockVideo.id}/edit`);

    const savePlaylistBtn = screen.getByTestId(`save-playlist-${mockVideo.id}`);
    expect(savePlaylistBtn).toBeTruthy();
  });
});
