import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UploadPage from '../src/app/[locale]/upload/page';
import StudioLayout from '../src/app/[locale]/studio/layout';
import { computePermissions } from '../src/lib/auth/permissions';

const mockPush = vi.fn();
let mockPathname = '/upload';

vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
  Link: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));

// Mock realtime context
vi.mock('../src/lib/realtime/realtime-context', () => ({
  useRealtimeRoom: () => {},
}));

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
      refresh: vi.fn(),
    };
  },
}));

// Mock API client for UpgradeCreatorView inside guard
vi.mock('../src/lib/api-client', () => ({
  api: {
    auth: {
      GET: vi.fn().mockResolvedValue({ response: { ok: false, status: 404 } }),
      POST: vi.fn().mockResolvedValue({ response: { ok: true } }),
    },
  },
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderWithClient(ui: React.ReactElement) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('Task ROLE1 (ADR-046): Route Guards for /upload and /studio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockReset();
  });

  describe('/upload Guard', () => {
    beforeEach(() => {
      mockPathname = '/upload';
    });

    it('session is loading: renders skeleton dropzone placeholder (zero CLS)', () => {
      mockAuthState = { user: null, isAuthenticated: false, isLoading: true };
      renderWithClient(<UploadPage />);
      expect(screen.getByTestId('upload-dropzone-skeleton')).toBeDefined();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('anonymous user: redirects to /login?return_to=/upload', () => {
      mockAuthState = { user: null, isAuthenticated: false, isLoading: false };
      renderWithClient(<UploadPage />);
      expect(mockPush).toHaveBeenCalledWith('/login?return_to=%2Fupload');
    });

    it('signed in without creator (viewer): renders upgrade view in place without flash or error', () => {
      mockAuthState = {
        user: { id: 'v1', email: 'v@w.vn', roles: ['viewer'] },
        isAuthenticated: true,
        isLoading: false,
      };
      renderWithClient(<UploadPage />);
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.queryByTestId('upload-tab-single')).toBeNull();
      // Renders upgrade view in place
      expect(
        screen.getByTestId('upgrade-creator-loading') ||
          screen.getByTestId('upgrade-creator-form-view'),
      ).toBeDefined();
    });

    it('signed in with creator: renders actual upload mode tabs and form', () => {
      mockAuthState = {
        user: { id: 'c1', email: 'c@w.vn', roles: ['viewer', 'creator'] },
        isAuthenticated: true,
        isLoading: false,
      };
      renderWithClient(<UploadPage />);
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.getByTestId('upload-tab-single')).toBeDefined();
      expect(screen.getByTestId('upload-tab-package')).toBeDefined();
    });
  });

  describe('/studio Layout Guard', () => {
    beforeEach(() => {
      mockPathname = '/studio/videos';
    });

    it('session is loading: renders studio placeholder skeleton', () => {
      mockAuthState = { user: null, isAuthenticated: false, isLoading: true };
      renderWithClient(
        <StudioLayout>
          <div data-testid="studio-content">Studio Content</div>
        </StudioLayout>,
      );
      expect(screen.getByTestId('studio-loading-placeholder')).toBeDefined();
      expect(screen.queryByTestId('studio-content')).toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('anonymous user: redirects to /login?return_to=/studio/videos', () => {
      mockAuthState = { user: null, isAuthenticated: false, isLoading: false };
      renderWithClient(
        <StudioLayout>
          <div data-testid="studio-content">Studio Content</div>
        </StudioLayout>,
      );
      expect(mockPush).toHaveBeenCalledWith('/login?return_to=%2Fstudio%2Fvideos');
      expect(screen.queryByTestId('studio-content')).toBeNull();
    });

    it('signed in without creator (viewer): renders upgrade view in place without error page', () => {
      mockAuthState = {
        user: { id: 'v1', email: 'v@w.vn', roles: ['viewer'] },
        isAuthenticated: true,
        isLoading: false,
      };
      renderWithClient(
        <StudioLayout>
          <div data-testid="studio-content">Studio Content</div>
        </StudioLayout>,
      );
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.queryByTestId('studio-content')).toBeNull();
      expect(
        screen.getByTestId('upgrade-creator-loading') ||
          screen.getByTestId('upgrade-creator-form-view'),
      ).toBeDefined();
    });

    it('signed in with creator: renders child studio content', () => {
      mockAuthState = {
        user: { id: 'c1', email: 'c@w.vn', roles: ['viewer', 'creator'] },
        isAuthenticated: true,
        isLoading: false,
      };
      renderWithClient(
        <StudioLayout>
          <div data-testid="studio-content">Studio Content</div>
        </StudioLayout>,
      );
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.getByTestId('studio-content')).toBeDefined();
    });
  });
});
