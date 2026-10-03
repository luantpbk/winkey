import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RelatedVideosColumn } from '../src/components/video/related-videos-column';
import { api } from '../src/lib/api-client';
import { tokenStore } from '../src/lib/auth/token-store';
import type { VideoSummary } from '@winkey/api-client';
import { formatDuration } from '../src/lib/format';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';

// --- Locale Mock ---
let activeLocale: 'vi' | 'en' = 'vi';
export function setTestLocale(locale: 'vi' | 'en') {
  activeLocale = locale;
}

vi.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
      const isVi = activeLocale === 'vi';
      if (key === 'views' && values && typeof values.count !== 'undefined') {
        const count = Number(values.count);
        return isVi ? `${count} lượt xem` : count === 1 ? '1 view' : `${count} views`;
      }
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
  },
}));

// --- Routing Mock ---
vi.mock('../src/i18n/routing', () => ({
  Link: ({
    children,
    href,
    className,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

// --- Toast Mock ---
const mockShowToast = vi.fn();
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 5 * 60 * 1000,
      },
    },
  });
}

function renderWithClient(ui: React.ReactElement, client = createTestQueryClient()) {
  return {
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
    client,
  };
}

const mock12RelatedVideos: VideoSummary[] = Array.from({ length: 12 }, (_, i) => ({
  id: `0192f5e4-7c1a-7b3e-9d2a-0000000000${(i + 1).toString().padStart(2, '0')}`,
  title: `Related Video Title ${i + 1}`,
  owner: {
    id: `0192f5e4-7c1a-7b3e-9d2a-c000000000${(i + 1).toString().padStart(2, '0')}`,
    display_name: `Channel Name ${i + 1}`,
    handle: `channel${i + 1}`,
    avatar_url: `https://example.com/avatar-${i + 1}.jpg`,
  },
  duration_ms: (i + 1) * 65000, // e.g. 1:05, 2:10...
  view_count: (i + 1) * 1500,
  published_at: new Date('2026-09-01T00:00:00Z').toISOString(),
  thumbnail_url: `https://example.com/thumb-${i + 1}.jpg`,
}));

describe('R2-c-web: Related Videos Column ("Xem tiếp")', () => {
  beforeEach(() => {
    tokenStore.clear();
    setTestLocale('vi');
    mockShowToast.mockClear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    tokenStore.clear();
    vi.restoreAllMocks();
  });

  it('the request has no Authorization header even when signed in', async () => {
    tokenStore.set('authenticated-user-jwt-token-999');

    let capturedHeaders: Headers | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      capturedHeaders = req.headers;
      return new Response(JSON.stringify({ items: mock12RelatedVideos }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    renderWithClient(<RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10" />);

    await waitFor(() => {
      expect(screen.getByTestId('related-videos-column')).toBeDefined();
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.has('Authorization')).toBe(false);
    expect(capturedHeaders?.has('authorization')).toBe(false);
  });

  it('renders 12 items in server order with title, channel, views, and duration', async () => {
    vi.spyOn(api.video, 'GET').mockImplementation(async (path, opts: any) => {
      if (path === '/v1/videos/{video_id}/related') {
        expect(opts.params.path.video_id).toBe('0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11');
        expect(opts.params.query.limit).toBe(12);
        return {
          data: { items: [...mock12RelatedVideos] },
          response: new Response(null, { status: 200 }),
        } as any;
      }
      return { response: new Response(null, { status: 404 }) } as any;
    });

    renderWithClient(<RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11" />);

    // 12 items rendered
    const cards = await screen.findAllByTestId('related-video-card');
    expect(cards).toHaveLength(12);

    // Verify server order and data content for each item
    for (let i = 0; i < 12; i++) {
      const card = cards[i];
      const expected = mock12RelatedVideos[i];

      expect(card.getAttribute('data-video-id')).toBe(expected.id);
      expect(card.textContent).toContain(expected.title);
      expect(card.textContent).toContain(expected.owner.display_name);

      // Channel link
      const channelLink = card.querySelector(`a[href="/c/${expected.owner.handle}"]`);
      expect(channelLink).not.toBeNull();

      // Watch link
      const watchLink = card.querySelector(`a[href="/watch/${expected.id}"]`);
      expect(watchLink).not.toBeNull();

      // Duration badge (formatted e.g. 1:05, 2:10)
      const expectedDuration = formatDuration(expected.duration_ms);
      expect(card.textContent).toContain(expectedDuration);
      expect(card.textContent).toContain(`${expected.view_count} lượt xem`);
    }
  });

  it('renders 6 skeleton rows during loading state', () => {
    // Keep query pending
    vi.spyOn(api.video, 'GET').mockImplementation(() => new Promise(() => {}));

    renderWithClient(<RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11" />);

    const skeletons = screen.getAllByTestId('related-video-skeleton');
    expect(skeletons).toHaveLength(6);
    expect(screen.getByText('Xem tiếp')).toBeDefined();
  });

  it('hides the column when items is empty (no empty box)', async () => {
    vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
      data: { items: [] },
      response: new Response(null, { status: 200 }),
    } as any);

    renderWithClient(<RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11" />);

    await waitFor(() => {
      expect(screen.queryByTestId('related-videos-column')).toBeNull();
    });
  });

  it('hides the column silently on 404 without logging an error or showing toast', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
      error: { type: '/problems/not-found', title: 'Video not found', status: 404 },
      response: new Response(null, { status: 404 }),
    } as any);

    renderWithClient(<RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12" />);

    await waitFor(() => {
      expect(screen.queryByTestId('related-videos-column')).toBeNull();
    });

    expect(mockShowToast).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('hides the column on 500 without showing toast or retry loop', async () => {
    vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
      error: { type: '/problems/internal-error', title: 'Server error', status: 500 },
      response: new Response(null, { status: 500 }),
    } as any);

    renderWithClient(<RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c13" />);

    await waitFor(() => {
      expect(screen.queryByTestId('related-videos-column')).toBeNull();
    });

    expect(mockShowToast).not.toHaveBeenCalled();
    // Only 1 call because retry is false
    expect(api.video.GET).toHaveBeenCalledTimes(1);
  });

  it('never renders the current video id defensively', async () => {
    const itemsWithCurrentVideo: VideoSummary[] = [
      mock12RelatedVideos[0],
      {
        ...mock12RelatedVideos[1],
        id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c14',
        title: 'Current Playing Video Should Be Filtered Out',
      },
      mock12RelatedVideos[2],
    ];

    vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
      data: { items: itemsWithCurrentVideo },
      response: new Response(null, { status: 200 }),
    } as any);

    renderWithClient(<RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c14" />);

    const cards = await screen.findAllByTestId('related-video-card');
    expect(cards).toHaveLength(2);
    expect(screen.queryByText('Current Playing Video Should Be Filtered Out')).toBeNull();
  });

  it('navigating to another video requests related for the new id (one request per video id)', async () => {
    const getSpy = vi.spyOn(api.video, 'GET').mockImplementation(async (path, opts: any) => {
      const vid = opts?.params?.path?.video_id;
      return {
        data: {
          items: [
            {
              ...mock12RelatedVideos[0],
              id: '0192f5e4-7c1a-7b3e-9d2a-999999999999',
              title: `Related for ${vid}`,
            },
          ],
        },
        response: new Response(null, { status: 200 }),
      } as any;
    });

    const client = createTestQueryClient();
    const { rerender } = renderWithClient(
      <RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c15" />,
      client,
    );

    await waitFor(() => {
      expect(screen.getByText('Related for 0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c15')).toBeDefined();
    });
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(
      '/v1/videos/{video_id}/related',
      expect.objectContaining({
        params: expect.objectContaining({
          path: { video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c15' },
          query: { limit: 12 },
        }),
      }),
    );

    // Navigate to video-beta
    rerender(
      <QueryClientProvider client={client}>
        <RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c16" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Related for 0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c16')).toBeDefined();
    });
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(getSpy).toHaveBeenLastCalledWith(
      '/v1/videos/{video_id}/related',
      expect.objectContaining({
        params: expect.objectContaining({
          path: { video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c16' },
          query: { limit: 12 },
        }),
      }),
    );
  });

  it('renders translated strings in Vietnamese ("Xem tiếp") and English ("Up next")', async () => {
    vi.spyOn(api.video, 'GET').mockResolvedValue({
      data: { items: [mock12RelatedVideos[0]] },
      response: new Response(null, { status: 200 }),
    } as any);

    // Vietnamese
    setTestLocale('vi');
    const { unmount } = renderWithClient(
      <RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c17" />,
    );
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'Xem tiếp' })).toBeDefined();
    });
    unmount();

    // English
    setTestLocale('en');
    renderWithClient(<RelatedVideosColumn videoId="0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c18" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'Up next' })).toBeDefined();
    });
  });
});
