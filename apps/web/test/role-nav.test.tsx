import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TopBar } from '../src/components/layout/top-bar';
import { Sidebar } from '../src/components/layout/sidebar';
import { BottomNav } from '../src/components/layout/bottom-nav';
import { WatchClientSection } from '../src/app/[locale]/watch/[id]/watch-client';
import { computePermissions } from '../src/lib/auth/permissions';
import type { Video } from '@winkey/api-client';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderWithClient(ui: React.ReactElement) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// Mock routing
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
  Link: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// Mock translations
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      upload: 'Tải lên',
      studio: 'Studio',
      home: 'Trang chủ',
      explore: 'Khám phá',
      library: 'Thư viện',
      history: 'Lịch sử',
      subscriptions: 'Kênh đăng ký',
      watchLater: 'Xem sau',
      accountSettings: 'Cài đặt tài khoản',
      signOut: 'Đăng xuất',
    };
    return map[key] || key;
  },
}));

// Mock Toast & feedback
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
  ToastProvider: ({ children }: any) => <>{children}</>,
}));

vi.mock('../src/lib/feedback', () => ({
  useFeedbackUrl: () => null,
}));

// Mock Auth
let mockAuthState = {
  user: null as any,
  isAuthenticated: false,
  isLoading: false,
};

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => {
    const can = computePermissions(mockAuthState.user, mockAuthState.isAuthenticated);
    return {
      user: mockAuthState.user,
      isAuthenticated: mockAuthState.isAuthenticated,
      isLoading: mockAuthState.isLoading,
      can,
      logout: vi.fn(),
    };
  },
}));

const mockVideo: Video = {
  id: 'vid-123',
  title: 'Test Video',
  description: 'Test Description',
  visibility: 'PUBLIC',
  status: 'READY',
  duration_ms: 120000,
  width: 1920,
  height: 1080,
  view_count: 500,
  like_count: 50,
  published_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  owner: {
    id: 'user-owner-1',
    handle: 'creator_user',
    display_name: 'Creator User',
    avatar_url: null,
  },
  playback: null,
};

describe('Task ROLE1 (ADR-046): Role-based Navigation & Visibility', () => {
  beforeEach(() => {
    mockAuthState = {
      user: null,
      isAuthenticated: false,
      isLoading: false,
    };
  });

  describe('1. TopBar Role Visibility', () => {
    it('Anonymous user: does not see Upload, Studio, or User menu', () => {
      mockAuthState = { user: null, isAuthenticated: false, isLoading: false };
      renderWithClient(<TopBar onToggleSidebar={() => {}} />);
      expect(screen.queryByTestId('topbar-upload-btn')).toBeNull();
      expect(screen.queryByTestId('topbar-studio-btn')).toBeNull();
      expect(screen.queryByLabelText('User profile menu')).toBeNull();
    });

    it('Viewer user: does not see Upload or Studio, but sees "Trở thành nhà sáng tạo" in menu', () => {
      mockAuthState = {
        user: { id: 'viewer-1', display_name: 'Viewer', roles: ['viewer'] },
        isAuthenticated: true,
        isLoading: false,
      };
      renderWithClient(<TopBar onToggleSidebar={() => {}} />);
      expect(screen.queryByTestId('topbar-upload-btn')).toBeNull();
      expect(screen.queryByTestId('topbar-studio-btn')).toBeNull();

      // Open dropdown
      const menuBtn = screen.getByLabelText('User profile menu');
      fireEvent.click(menuBtn);

      expect(screen.getByTestId('user-menu-upgrade-btn')).toBeDefined();
      expect(screen.queryByTestId('user-menu-studio-btn')).toBeNull();
      expect(screen.queryByTestId('user-menu-admin-btn')).toBeNull();
    });

    it('Creator user: sees Upload and Studio buttons, and Studio in menu, but no upgrade button', () => {
      mockAuthState = {
        user: { id: 'creator-1', display_name: 'Creator', roles: ['viewer', 'creator'] },
        isAuthenticated: true,
        isLoading: false,
      };
      renderWithClient(<TopBar onToggleSidebar={() => {}} />);
      expect(screen.getByTestId('topbar-upload-btn')).toBeDefined();
      expect(screen.getByTestId('topbar-studio-btn')).toBeDefined();

      const menuBtn = screen.getByLabelText('User profile menu');
      fireEvent.click(menuBtn);

      expect(screen.getByTestId('user-menu-studio-btn')).toBeDefined();
      expect(screen.queryByTestId('user-menu-upgrade-btn')).toBeNull();
      expect(screen.queryByTestId('user-menu-admin-btn')).toBeNull();
    });

    it('Moderator user without creator: no Upload/Studio, sees upgrade and admin in menu', () => {
      mockAuthState = {
        user: { id: 'mod-1', display_name: 'Mod', roles: ['viewer', 'moderator'] },
        isAuthenticated: true,
        isLoading: false,
      };
      renderWithClient(<TopBar onToggleSidebar={() => {}} />);
      expect(screen.queryByTestId('topbar-upload-btn')).toBeNull();
      expect(screen.queryByTestId('topbar-studio-btn')).toBeNull();

      const menuBtn = screen.getByLabelText('User profile menu');
      fireEvent.click(menuBtn);

      expect(screen.getByTestId('user-menu-upgrade-btn')).toBeDefined();
      expect(screen.getByTestId('user-menu-admin-btn')).toBeDefined();
      expect(screen.queryByTestId('user-menu-studio-btn')).toBeNull();
    });

    it('Admin user with creator: sees Upload, Studio, Admin in menu, no upgrade button', () => {
      mockAuthState = {
        user: { id: 'admin-1', display_name: 'Admin', roles: ['viewer', 'creator', 'admin'] },
        isAuthenticated: true,
        isLoading: false,
      };
      renderWithClient(<TopBar onToggleSidebar={() => {}} />);
      expect(screen.getByTestId('topbar-upload-btn')).toBeDefined();
      expect(screen.getByTestId('topbar-studio-btn')).toBeDefined();

      const menuBtn = screen.getByLabelText('User profile menu');
      fireEvent.click(menuBtn);

      expect(screen.getByTestId('user-menu-studio-btn')).toBeDefined();
      expect(screen.getByTestId('user-menu-admin-btn')).toBeDefined();
      expect(screen.queryByTestId('user-menu-upgrade-btn')).toBeNull();
    });
  });

  describe('2. Sidebar Role Visibility', () => {
    it('Viewer: no Studio, no Admin, no Upload links', () => {
      mockAuthState = {
        user: { id: 'viewer-1', roles: ['viewer'] },
        isAuthenticated: true,
        isLoading: false,
      };
      render(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);
      expect(screen.queryByRole('link', { name: /Studio/i })).toBeNull();
      expect(screen.queryByRole('link', { name: /Admin/i })).toBeNull();
      expect(screen.queryByRole('link', { name: /Tải lên/i })).toBeNull();
    });

    it('Creator: has Studio and Upload links, but no Admin', () => {
      mockAuthState = {
        user: { id: 'creator-1', roles: ['viewer', 'creator'] },
        isAuthenticated: true,
        isLoading: false,
      };
      render(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);
      expect(screen.getByRole('link', { name: /Studio/i })).toBeDefined();
      expect(screen.getByRole('link', { name: /Tải lên/i })).toBeDefined();
      expect(screen.queryByRole('link', { name: /Admin/i })).toBeNull();
    });

    it('Moderator: has Admin link, no Studio or Upload', () => {
      mockAuthState = {
        user: { id: 'mod-1', roles: ['viewer', 'moderator'] },
        isAuthenticated: true,
        isLoading: false,
      };
      render(<Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} />);
      expect(screen.getByRole('link', { name: /Admin/i })).toBeDefined();
      expect(screen.queryByRole('link', { name: /Studio/i })).toBeNull();
      expect(screen.queryByRole('link', { name: /Tải lên/i })).toBeNull();
    });
  });

  describe('3. BottomNav Role Visibility', () => {
    it('Non-creator (viewer / anonymous): 4th tab is "Thư viện"', () => {
      mockAuthState = {
        user: { id: 'viewer-1', roles: ['viewer'] },
        isAuthenticated: true,
        isLoading: false,
      };
      render(<BottomNav />);
      expect(screen.getByRole('link', { name: /Thư viện/i })).toBeDefined();
      expect(screen.queryByRole('link', { name: /Tải lên/i })).toBeNull();
    });

    it('Creator: 4th tab is "Tải lên" (/upload)', () => {
      mockAuthState = {
        user: { id: 'creator-1', roles: ['viewer', 'creator'] },
        isAuthenticated: true,
        isLoading: false,
      };
      render(<BottomNav />);
      expect(screen.getByRole('link', { name: /Tải lên/i })).toBeDefined();
      expect(screen.queryByRole('link', { name: /Thư viện/i })).toBeNull();
    });
  });

  describe('4. Watch Page Owner Actions', () => {
    it('Non-creator owner (roles: ["viewer"]): Edit and Subtitles buttons are hidden', () => {
      mockAuthState = {
        user: { id: 'user-owner-1', roles: ['viewer'] }, // owner matches video.owner.id
        isAuthenticated: true,
        isLoading: false,
      };
      render(<WatchClientSection video={mockVideo} />);
      expect(screen.queryByTestId('owner-edit-video-btn')).toBeNull();
      expect(screen.queryByTestId('owner-manage-subtitles')).toBeNull();
    });

    it('Creator owner (roles: ["viewer", "creator"]): Edit and Subtitles buttons are visible', () => {
      mockAuthState = {
        user: { id: 'user-owner-1', roles: ['viewer', 'creator'] },
        isAuthenticated: true,
        isLoading: false,
      };
      render(<WatchClientSection video={mockVideo} />);
      expect(screen.getByTestId('owner-edit-video-btn')).toBeDefined();
      expect(screen.getByTestId('owner-manage-subtitles')).toBeDefined();
    });
  });
});
