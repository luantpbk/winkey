import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'fs';
import path from 'path';
import { ToastProvider } from '../src/components/ui/toast';
import { HistoryView } from '../src/components/history/history-view';
import { Sidebar } from '../src/components/layout/sidebar';
import {
  getDynamicWatchHistory,
  setDynamicWatchHistory,
  resetDynamicWatchHistory,
} from '../src/mocks/handlers';
import { server } from '../src/mocks/server';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';
import type { HistoryItem } from '@winkey/api-client';

// --- Locale Mock ---
const activeLocale: 'vi' | 'en' = 'vi';

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
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
  },
}));

// --- Router Mock ---
const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/lich-su',
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

// --- Auth Mock ---
let mockIsAuthenticated = true;
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockIsAuthenticated
      ? {
          id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
          handle: 'test_user',
          display_name: 'Test User',
          roles: ['user'],
        }
      : null,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe('HIST1: Watch History (/lich-su) Unit Tests (ADR-044)', () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'bypass' });
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthenticated = true;
    resetDynamicWatchHistory();
  });

  afterEach(() => {
    server.resetHandlers();
    resetDynamicWatchHistory();
  });

  describe('1. Sidebar Navigation', () => {
    it('restores "Lịch sử" link pointing to /lich-su', () => {
      renderWithProviders(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);

      const historyLinks = screen.getAllByRole('link', { name: /lịch sử/i });
      expect(historyLinks.length).toBeGreaterThan(0);
      const link = historyLinks.find((l) => l.getAttribute('href') === '/lich-su');
      expect(link).toBeDefined();
      expect(link?.getAttribute('href')).toBe('/lich-su');
    });
  });

  describe('2. Unauthenticated Guest State', () => {
    it('renders login prompt with invitation title, desc, and link to login with return_to=/lich-su', async () => {
      mockIsAuthenticated = false;

      renderWithProviders(<HistoryView />);

      const prompt = screen.getByTestId('history-login-prompt');
      expect(prompt).toBeDefined();

      expect(screen.getByText('Lưu lại video bạn đã xem')).toBeDefined();
      expect(
        screen.getByText('Đăng nhập để xem lịch sử phát video trên Winkey từ mọi thiết bị.'),
      ).toBeDefined();

      const loginBtn = screen.getByTestId('history-login-btn');
      expect(loginBtn.getAttribute('href')).toBe('/login?return_to=/lich-su');
    });
  });

  describe('3. Authenticated State with History Items', () => {
    it('renders watch history list with title, clear all button, and video rows', async () => {
      renderWithProviders(<HistoryView />);

      // Wait for items to load
      const title = await screen.findByText('Lịch sử xem');
      expect(title).toBeDefined();

      const clearBtn = await screen.findByTestId('clear-all-history-btn');
      expect(clearBtn).toBeDefined();

      const items = getDynamicWatchHistory();
      expect(items.length).toBeGreaterThan(0);

      // Verify first item is rendered
      const firstItem = items[0];
      const videoRow = await screen.findByTestId(`history-item-${firstItem.video.id}`);
      expect(videoRow).toBeDefined();
      expect(within(videoRow).getByText(firstItem.video.title)).toBeDefined();
      expect(within(videoRow).getByText(firstItem.video.owner.display_name)).toBeDefined();

      // Check remove button exists with proper aria-label
      const removeBtn = screen.getByTestId(`remove-history-${firstItem.video.id}`);
      expect(removeBtn).toBeDefined();
      expect(removeBtn.getAttribute('aria-label')).toBe('Xoá khỏi nhật ký xem');
    });

    it('deletes a single video item optimistically on click', async () => {
      renderWithProviders(<HistoryView />);

      const items = getDynamicWatchHistory();
      const targetId = items[0].video.id;

      await screen.findByTestId(`history-item-${targetId}`);

      const removeBtn = screen.getByTestId(`remove-history-${targetId}`);
      fireEvent.click(removeBtn);

      // Optimistically removed
      await waitFor(() => {
        expect(screen.queryByTestId(`history-item-${targetId}`)).toBeNull();
      });

      // Toast notification displayed
      await waitFor(() => {
        expect(screen.getByText('Đã xoá video khỏi lịch sử xem')).toBeDefined();
      });
    });
  });

  describe('4. Clear All Watch History with Confirmation Modal', () => {
    it('opens confirmation dialog, allows canceling, and performs clear on confirm', async () => {
      renderWithProviders(<HistoryView />);

      const clearBtn = await screen.findByTestId('clear-all-history-btn');
      fireEvent.click(clearBtn);

      // Modal appears
      const dialog = await screen.findByTestId('clear-history-dialog');
      expect(dialog).toBeDefined();
      expect(screen.getByText('Xoá lịch sử xem video?')).toBeDefined();
      expect(
        screen.getByText(
          'Thao tác này sẽ xoá toàn bộ lịch sử xem video của tài khoản trên mọi thiết bị. Bạn sẽ không thể hoàn tác.',
        ),
      ).toBeDefined();

      // Click Cancel first
      const cancelBtn = screen.getByTestId('cancel-clear-history-btn');
      fireEvent.click(cancelBtn);

      await waitFor(() => {
        expect(screen.queryByTestId('clear-history-dialog')).toBeNull();
      });

      // History items still present
      expect(screen.getAllByTestId(/^history-item-/).length).toBeGreaterThan(0);

      // Re-open and Confirm
      fireEvent.click(clearBtn);
      const confirmBtn = await screen.findByTestId('confirm-clear-history-btn');
      fireEvent.click(confirmBtn);

      // Optimistically clears items and shows empty state
      await waitFor(() => {
        expect(screen.getByTestId('history-empty-state')).toBeDefined();
      });
      expect(screen.getByText('Danh sách này không có video nào.')).toBeDefined();
      expect(screen.getByText('Các video bạn xem khi đăng nhập sẽ xuất hiện ở đây.')).toBeDefined();
      expect(screen.getByTestId('history-explore-btn').getAttribute('href')).toBe('/kham-pha');
      expect(screen.queryByTestId('clear-all-history-btn')).toBeNull();

      // Toast notification displayed
      await waitFor(() => {
        expect(screen.getByText('Đã xoá toàn bộ lịch sử xem')).toBeDefined();
      });
    });
  });

  describe('5. Empty State', () => {
    it('renders empty state directly when watch history is empty', async () => {
      setDynamicWatchHistory([]);

      renderWithProviders(<HistoryView />);

      const emptyState = await screen.findByTestId('history-empty-state');
      expect(emptyState).toBeDefined();
      expect(screen.getByText('Danh sách này không có video nào.')).toBeDefined();
      expect(screen.getByTestId('history-explore-btn').getAttribute('href')).toBe('/kham-pha');
      expect(screen.queryByTestId('clear-all-history-btn')).toBeNull();
    });
  });

  describe('6. AST / Dead Button Safety Rule', () => {
    it('verifies all <button> elements in components/history have onClick, type="submit", or disabled', () => {
      const historyComponentsDir = path.resolve(__dirname, '../src/components/history');
      const files = fs.readdirSync(historyComponentsDir).filter((f) => f.endsWith('.tsx'));

      expect(files.length).toBeGreaterThan(0);

      const deadButtons: { file: string; line: number; tag: string }[] = [];

      for (const file of files) {
        const filePath = path.join(historyComponentsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const regex = /<button\b([\s\S]*?)>/g;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(content)) !== null) {
          const attrs = match[1];
          const hasHandler = /\bon(?:Click|MouseDown|PointerDown|KeyDown)\s*=/.test(attrs);
          const isSubmit = /\btype\s*=\s*["']submit["']/.test(attrs);
          const isDisabled = /\bdisabled\b/.test(attrs);

          if (!hasHandler && !isSubmit && !isDisabled) {
            const upToMatch = content.slice(0, match.index);
            const line = upToMatch.split('\n').length;
            deadButtons.push({ file, line, tag: match[0].slice(0, 80) });
          }
        }
      }

      expect(
        deadButtons,
        `Found dead <button> without handler or disabled in components/history: ${JSON.stringify(deadButtons, null, 2)}`,
      ).toHaveLength(0);
    });
  });
});
