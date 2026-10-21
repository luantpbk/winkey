import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui/toast';
import { LibraryView } from '../src/components/library/library-view';
import RegisterPage from '../src/app/[locale]/register/page';
import { api } from '../src/lib/api-client';
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
  useLocale: () => 'vi',
}));

// --- Router & Params Mock ---
const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'vi' }),
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/thu-vien',
}));

vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/thu-vien',
  Link: ({
    children,
    href,
    className,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
    [key: string]: unknown;
  }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

// --- Auth Mock ---
let mockIsAuthenticated = true;
let mockIsAuthLoading = false;

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockIsAuthLoading,
    user: mockIsAuthenticated
      ? {
          id: '0192f5e4-7c1a-7b3e-9d2a-user00000001',
          handle: 'testcreator',
          display_name: 'Test Creator',
          roles: ['creator'],
        }
      : null,
    register: vi.fn().mockResolvedValue({ success: true }),
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

describe('UX1: CLS Stability & Layout Shift Prevention (#408)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthenticated = true;
    mockIsAuthLoading = false;
    mockSearchParams = new URLSearchParams();
  });

  describe('1. /thu-vien Layout Containment & Skeleton Geometry', () => {
    it('renders static page header and skeleton grid immediately during loading instead of shifting with a blank spinner', async () => {
      // Return delayed response to observe initial skeleton
      vi.spyOn(api.social, 'GET').mockImplementation(
        () => new Promise(() => {}), // never resolves in this test
      );

      renderWithProviders(<LibraryView />);

      // Static header is present from frame 0
      expect(screen.getByTestId('library-page-title')).toBeDefined();
      expect(screen.getByTestId('create-playlist-btn')).toBeDefined();

      // Skeleton grid is rendered in place
      const skeletonGrid = screen.getByTestId('library-playlists-skeleton');
      expect(skeletonGrid).toBeDefined();
      expect(skeletonGrid.className).toContain('grid-cols-1');
      expect(skeletonGrid.className).toContain('sm:grid-cols-2');
      expect(skeletonGrid.className).toContain('md:grid-cols-3');
      expect(skeletonGrid.className).toContain('lg:grid-cols-4');
    });

    it('mounts playlist cards with intrinsic aspect-ratio and absolute cover image', async () => {
      vi.spyOn(api.social, 'GET').mockImplementation(async (path: string) => {
        if (path === '/v1/channels/{channel_id}/playlists') {
          return {
            data: {
              items: [
                {
                  id: 'pl-1',
                  title: 'Danh sách phát 1',
                  kind: 'CUSTOM',
                  visibility: 'PUBLIC',
                  item_count: 5,
                  created_at: '2026-01-01T00:00:00Z',
                  updated_at: '2026-01-01T00:00:00Z',
                },
              ],
              next_cursor: null,
            },
            response: new Response(),
          } as any;
        }
        return { data: null, response: new Response() } as any;
      });

      renderWithProviders(<LibraryView />);

      await waitFor(() => {
        expect(screen.getByTestId('library-playlists-grid')).toBeDefined();
      });

      const card = screen.getByTestId('library-playlist-card-pl-1');
      expect(card).toBeDefined();

      // Check aspect-ratio container on thumbnail wrapper
      const thumbWrapper = card.querySelector('.aspect-video');
      expect(thumbWrapper).toBeDefined();
      expect(thumbWrapper?.className).toContain('aspect-video');
      expect(thumbWrapper?.className).toContain('relative');
    });
  });

  describe('2. /register Error Slot Reservation & Zero-Shift Form', () => {
    it('maintains fixed error reservation slots preventing input displacement when errors appear', async () => {
      mockSearchParams = new URLSearchParams({ error: 'INVITE_REQUIRED' });

      render(<RegisterPage />);

      // The invite code error should be rendered within a reserved slot
      const inviteError = await screen.findByTestId('invite-error-msg');
      expect(inviteError).toBeDefined();
      expect(inviteError.parentElement?.className).toContain('min-h-[18px]');

      // All input groups have min-h-[18px] reserved slots
      const inputs = screen.getAllByRole('textbox');
      expect(inputs.length).toBeGreaterThanOrEqual(4);
      for (const input of inputs) {
        const slot = input.parentElement?.querySelector('.min-h-\\[18px\\]');
        expect(slot).toBeDefined();
      }
    });
  });
});
