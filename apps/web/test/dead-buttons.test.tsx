import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { CinemaDetailDialog } from '../src/components/cinema/cinema-detail-dialog';
import KhamPhaPage, { CATEGORY_CHIPS } from '../src/app/[locale]/kham-pha/page';
import { Sidebar } from '../src/components/layout/sidebar';
import { ToastProvider } from '../src/components/ui/toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../src/lib/api-client';
import type { Video, VideoSummary } from '@winkey/api-client';
import viMessages from '../messages/vi.json';

// --- Locale Mock ---
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: unknown = viMessages;
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

// --- Router & Pathname Mock ---
const mockPush = vi.fn();
let mockSearchParamString = '';

vi.mock('../src/i18n/routing', () => ({
  routing: {
    locales: ['vi', 'en'],
    defaultLocale: 'vi',
    localePrefix: 'as-needed',
  },
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/kham-pha',
  Link: ({
    children,
    href,
    className,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
    onClick?: React.MouseEventHandler;
    [key: string]: unknown;
  }) => (
    <a href={href} className={className} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/kham-pha',
  useSearchParams: () => new URLSearchParams(mockSearchParamString),
}));

// --- Auth Mock ---
let mockIsAuthenticated = false;
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockIsAuthenticated ? { id: 'user-1', email: 'test@example.com' } : null,
    isLoading: false,
    canAccessAdmin: false,
  }),
}));

const mockVideoDetail: Video = {
  id: 'vid-like-1',
  title: 'Video Chi Tiết Thích',
  description: 'Mô tả video chi tiết',
  duration_ms: 120000,
  visibility: 'PUBLIC',
  status: 'READY',
  width: 1920,
  height: 1080,
  view_count: 500,
  like_count: 42,
  published_at: '2026-09-01T00:00:00Z',
  created_at: '2026-09-01T00:00:00Z',
  owner: {
    id: 'owner-1',
    handle: 'creator',
    display_name: 'Creator',
    avatar_url: 'https://example.com/avatar.jpg',
  },
  playback: {
    hls_url: 'https://example.com/master.m3u8',
    thumbnail_url: 'https://example.com/thumb.jpg',
    renditions: [],
  },
};

describe('UX1 Phase 1 (ADR-044): Dead Controls & Button Rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthenticated = false;
    mockSearchParamString = '';
  });

  describe('1. AST Codebase Rule: No dead <button> across apps/web/src', () => {
    it('enforces that every <button> element has onClick, onMouseDown, type="submit", or disabled', () => {
      function scanDir(dir: string, fileList: string[] = []): string[] {
        for (const entry of fs.readdirSync(dir)) {
          const fullPath = path.join(dir, entry);
          if (fs.statSync(fullPath).isDirectory()) {
            scanDir(fullPath, fileList);
          } else if (fullPath.endsWith('.tsx')) {
            fileList.push(fullPath);
          }
        }
        return fileList;
      }

      const srcDir = path.resolve(__dirname, '../src');
      const tsxFiles = scanDir(srcDir);
      expect(tsxFiles.length).toBeGreaterThan(0);

      const deadButtons: { file: string; line: number; tag: string }[] = [];

      for (const filePath of tsxFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        // Match <button ... > tags
        const regex = /<button\b([\s\S]*?)>/g;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(content)) !== null) {
          const attrs = match[1];
          const hasHandler = /\bon(?:Click|MouseDown|PointerDown|KeyDown)\s*=/.test(attrs);
          const isSubmit = /\btype\s*=\s*["']submit["']/.test(attrs);
          const isDisabled = /\bdisabled\b/.test(attrs);

          if (!hasHandler && !isSubmit && !isDisabled) {
            const line = content.substring(0, match.index).split('\n').length;
            deadButtons.push({
              file: path.relative(srcDir, filePath),
              line,
              tag: match[0].replace(/\s+/g, ' ').substring(0, 120),
            });
          }
        }
      }

      expect(deadButtons).toEqual([]);
    });
  });

  describe('2. CinemaDetailDialog Like Button Wiring', () => {
    beforeEach(() => {
      vi.spyOn(api.video, 'GET').mockImplementation((path: string) => {
        if (path === '/v1/videos/{video_id}') {
          return Promise.resolve({
            data: mockVideoDetail,
            response: new Response(JSON.stringify(mockVideoDetail), { status: 200 }),
          } as never);
        }
        if (path === '/v1/videos/{video_id}/related') {
          return Promise.resolve({
            data: { items: [], next_cursor: null },
            response: new Response(JSON.stringify({ items: [] }), { status: 200 }),
          } as never);
        }
        return Promise.reject(new Error('Unknown path'));
      });

      vi.spyOn(api.social, 'GET').mockImplementation((path: string) => {
        if (path === '/v1/videos/{video_id}/like') {
          return Promise.resolve({
            data: { liked: false, like_count: 42 },
            response: new Response(JSON.stringify({ liked: false, like_count: 42 }), {
              status: 200,
            }),
          } as never);
        }
        return Promise.reject(new Error('Unknown path'));
      });
    });

    it('renders Like button with aria-pressed="false" and prompts anonymous user to log in', async () => {
      mockIsAuthenticated = false;

      render(
        <ToastProvider>
          <CinemaDetailDialog videoId="vid-like-1" onClose={vi.fn()} onSelectVideo={vi.fn()} />
        </ToastProvider>,
      );

      const likeBtn = await screen.findByTestId('cinema-detail-like-btn');
      expect(likeBtn).toBeDefined();
      expect(likeBtn.getAttribute('aria-pressed')).toBe('false');

      fireEvent.click(likeBtn);

      expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/login?returnTo='));
    });

    it('toggles like state optimistically and calls PUT/DELETE for authenticated user', async () => {
      mockIsAuthenticated = true;

      const putSpy = vi.spyOn(api.social, 'PUT').mockResolvedValue({
        data: { liked: true, like_count: 43 },
        response: new Response(JSON.stringify({ liked: true, like_count: 43 }), { status: 200 }),
      } as never);

      const deleteSpy = vi.spyOn(api.social, 'DELETE').mockResolvedValue({
        data: { liked: false, like_count: 42 },
        response: new Response(JSON.stringify({ liked: false, like_count: 42 }), { status: 200 }),
      } as never);

      render(
        <ToastProvider>
          <CinemaDetailDialog videoId="vid-like-1" onClose={vi.fn()} onSelectVideo={vi.fn()} />
        </ToastProvider>,
      );

      const likeBtn = await screen.findByTestId('cinema-detail-like-btn');
      expect(likeBtn.getAttribute('aria-pressed')).toBe('false');

      // Click to like
      fireEvent.click(likeBtn);
      expect(likeBtn.getAttribute('aria-pressed')).toBe('true');
      expect(putSpy).toHaveBeenCalledWith('/v1/videos/{video_id}/like', {
        params: { path: { video_id: 'vid-like-1' } },
      });

      await waitFor(() => {
        expect(likeBtn.getAttribute('aria-pressed')).toBe('true');
      });

      // Click to unlike
      fireEvent.click(likeBtn);
      expect(likeBtn.getAttribute('aria-pressed')).toBe('false');
      expect(deleteSpy).toHaveBeenCalledWith('/v1/videos/{video_id}/like', {
        params: { path: { video_id: 'vid-like-1' } },
      });
    });
  });

  describe('3. /kham-pha Category Chips Filter & URL Sync', () => {
    let queryClient: QueryClient;

    beforeEach(() => {
      queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      });

      vi.spyOn(api.video, 'GET').mockResolvedValue({
        data: { items: [], next_cursor: null, total: 0 },
        response: new Response(JSON.stringify({ items: [] }), { status: 200 }),
      } as never);
    });

    it('renders all defined category chips and defaults to "all" with aria-pressed="true"', async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <KhamPhaPage />
        </QueryClientProvider>,
      );

      for (const chip of CATEGORY_CHIPS) {
        const chipBtn = screen.getByTestId(`category-chip-${chip.id}`);
        expect(chipBtn).toBeDefined();
        if (chip.id === 'all') {
          expect(chipBtn.getAttribute('aria-pressed')).toBe('true');
        } else {
          expect(chipBtn.getAttribute('aria-pressed')).toBe('false');
        }
      }
    });

    it('updates selection and URL query ?cat= when clicking a category chip', async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <KhamPhaPage />
        </QueryClientProvider>,
      );

      const techChip = screen.getByTestId('category-chip-cong-nghe');
      fireEvent.click(techChip);

      expect(techChip.getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('category-chip-all').getAttribute('aria-pressed')).toBe('false');
      expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('cat=cong-nghe'));
    });

    it('initializes selection from ?cat= searchParam on reload', async () => {
      mockSearchParamString = 'cat=hoc-lap-trinh';

      render(
        <QueryClientProvider client={queryClient}>
          <KhamPhaPage />
        </QueryClientProvider>,
      );

      const codingChip = screen.getByTestId('category-chip-hoc-lap-trinh');
      expect(codingChip.getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('category-chip-all').getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('4. Sidebar Navigation: Hide #history until HIST1', () => {
    it('does not render #history link in sidebar', () => {
      render(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);

      const historyLink = screen.queryByRole('link', { name: /lịch sử/i });
      expect(historyLink).toBeNull();

      const deadHashLinks = screen
        .queryAllByRole('link')
        .filter((l) => l.getAttribute('href') === '#history');
      expect(deadHashLinks).toHaveLength(0);
    });
  });
});
