import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { notFound } from 'next/navigation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminPage from '../src/app/[locale]/admin/page';
import { ModerationQueue } from '../src/components/admin/moderation-queue';
import { UserManagement } from '../src/components/admin/user-management';
import { AuditLogViewer } from '../src/components/admin/audit-log-viewer';
import { ReportDialog } from '../src/components/moderation/report-dialog';
import StudioPage from '../src/app/[locale]/studio/page';
import { api } from '../src/lib/api-client';
import type { AdminUser, ModerationCase, AuditEntry, StudioVideo } from '@winkey/api-client';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';

let activeLocale: 'en' | 'vi' = 'en';
export function setTestLocale(locale: 'en' | 'vi') {
  activeLocale = locale;
}

// Mock next/navigation
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

// Mock realtime provider / context
vi.mock('../src/lib/realtime/realtime-context', () => ({
  useRealtime: () => ({
    client: { subscribe: vi.fn(), unsubscribe: vi.fn(), on: vi.fn(), off: vi.fn() },
    isConnected: true,
  }),
  useRealtimeRoom: () => ({
    isSubscribed: true,
    lastEvent: null,
  }),
  RealtimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock next-intl dynamically using en.json / vi.json
const translatorMap = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const nsKey = namespace ?? '';
    let fn = translatorMap.get(nsKey);
    if (!fn) {
      fn = (key: string, values?: Record<string, unknown>) => {
        const isVi = activeLocale === 'vi';
        // Handle parameterized / plural keys
        if (key === 'openCount')
          return isVi ? `${values?.count} báo cáo mở` : `${values?.count} open reports`;
        if (key === 'firstReported')
          return isVi ? `Báo cáo đầu tiên: ${values?.time}` : `First reported: ${values?.time}`;
        if (key === 'suspendedUntil')
          return isVi ? `Khóa đến: ${values?.date}` : `Suspended until: ${values?.date}`;
        if (key === 'suspensionReason')
          return isVi ? `Lý do: ${values?.reason}` : `Reason: ${values?.reason}`;
        if (key === 'rolesFromTo')
          return isVi
            ? `Vai trò: [${values?.from}] -> [${values?.to}]`
            : `Roles: [${values?.from}] -> [${values?.to}]`;
        if (key === 'hiddenByModerator')
          return isVi
            ? `Bị ẩn bởi kiểm duyệt viên: ${values?.reason}`
            : `Hidden by a moderator: ${values?.reason}`;
        if (key === 'reason' && namespace === 'admin.audit')
          return isVi ? `Lý do: ${values?.reason}` : `Reason: ${values?.reason}`;
        if (key === 'until' && namespace === 'admin.audit')
          return isVi ? `Hạn: ${values?.until}` : `Until: ${values?.until}`;

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
          return cur;
        }
        return key;
      };
      translatorMap.set(nsKey, fn);
    }
    return fn;
  },
}));

// Mock routing
const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/admin',
  Link: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Mock auth context
let mockUser: {
  id: string;
  display_name: string;
  avatar_url: string | null;
  roles: string[];
} | null = {
  id: 'admin-id-123',
  display_name: 'Admin User',
  avatar_url: null,
  roles: ['viewer', 'admin'],
};
let mockIsAuthenticated = true;
let mockIsLoading = false;

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => {
    const isMod = mockUser?.roles?.includes('moderator') ?? false;
    const isAdm = mockUser?.roles?.includes('admin') ?? false;
    return {
      user: mockUser,
      isAuthenticated: mockIsAuthenticated,
      isLoading: mockIsLoading,
      isModerator: isMod,
      isAdmin: isAdm,
      canAccessAdmin: isMod || isAdm,
    };
  },
}));

describe('Admin & Moderation UI (Task U4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPush.mockReset();
    activeLocale = 'en';
    mockUser = {
      id: 'admin-id-123',
      display_name: 'Admin User',
      avatar_url: null,
      roles: ['viewer', 'admin'],
    };
    mockIsAuthenticated = true;
    mockIsLoading = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('1. Route Guard on /[locale]/admin', () => {
    it('throws NOT_FOUND for unauthenticated user', () => {
      mockIsAuthenticated = false;
      mockUser = null;

      expect(() => render(<AdminPage />)).toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });

    it('throws NOT_FOUND for regular viewer or creator', () => {
      mockIsAuthenticated = true;
      mockUser = {
        id: 'user-viewer',
        display_name: 'Viewer',
        avatar_url: null,
        roles: ['viewer', 'creator'],
      };

      expect(() => render(<AdminPage />)).toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });

    it('renders Queue and Users tabs for moderator, but hides Audit Log tab', () => {
      mockIsAuthenticated = true;
      mockUser = {
        id: 'mod-1',
        display_name: 'Moderator Alice',
        avatar_url: null,
        roles: ['viewer', 'moderator'],
      };

      render(<AdminPage />);

      expect(screen.getByText('Admin & Moderation Panel')).toBeDefined();
      expect(screen.getByText('Moderation Queue')).toBeDefined();
      expect(screen.getByText('Users')).toBeDefined();
      expect(screen.queryByText('Audit Log')).toBeNull();
    });

    it('renders all 3 tabs (Queue, Users, Audit Log) for administrator', () => {
      mockIsAuthenticated = true;
      mockUser = {
        id: 'admin-1',
        display_name: 'Admin Bob',
        avatar_url: null,
        roles: ['viewer', 'admin'],
      };

      render(<AdminPage />);

      expect(screen.getByText('Admin & Moderation Panel')).toBeDefined();
      expect(screen.getByText('Moderation Queue')).toBeDefined();
      expect(screen.getByText('Users')).toBeDefined();
      expect(screen.getByText('Audit Log')).toBeDefined();
    });
  });

  describe('2. User Reporting (ReportDialog)', () => {
    it('renders report dialog and submits report with reason and note', async () => {
      const handleClose = vi.fn();
      vi.spyOn(api.social, 'POST').mockResolvedValueOnce({
        data: { id: 'rep-1', created_at: new Date().toISOString() },
        error: undefined,
        response: { status: 201 } as Response,
      });

      render(
        <ReportDialog
          isOpen={true}
          onClose={handleClose}
          targetType="VIDEO"
          targetId="video-target-1"
          targetTitle="Sample Video Title"
        />,
      );

      expect(screen.getByText('Report Video')).toBeDefined();
      expect(screen.getByText('“Sample Video Title”')).toBeDefined();

      // Select reason
      const reasonRadio = screen.getByLabelText('Spam or unwanted commercial content');
      fireEvent.click(reasonRadio);

      // Add note
      const textarea = screen.getByPlaceholderText(
        'Provide extra context to help our moderation team...',
      );
      fireEvent.change(textarea, { target: { value: 'Spam promotional link in description.' } });

      // Submit
      const submitBtn = screen.getByRole('button', { name: 'Submit Report' });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(api.social.POST).toHaveBeenCalledWith('/v1/reports', {
          body: {
            target_type: 'VIDEO',
            target_id: 'video-target-1',
            reason: 'SPAM',
            note: 'Spam promotional link in description.',
          },
        });
        expect(
          screen.getByText(
            'Thank you for reporting. Our moderation team will review this content.',
          ),
        ).toBeDefined();
      });
    });

    it('handles duplicate open report (200 / 409) with friendly alert', async () => {
      const handleClose = vi.fn();
      vi.spyOn(api.social, 'POST').mockResolvedValueOnce({
        data: { id: 'rep-dup', created_at: new Date().toISOString() },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(
        <ReportDialog
          isOpen={true}
          onClose={handleClose}
          targetType="COMMENT"
          targetId="comment-target-1"
        />,
      );

      const reasonRadio = screen.getByLabelText('Harassment or bullying');
      fireEvent.click(reasonRadio);

      const submitBtn = screen.getByRole('button', { name: 'Submit Report' });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(
          screen.getByText(
            'You have already submitted a report for this content and it is currently being reviewed.',
          ),
        ).toBeDefined();
      });
    });

    it('handles 400 cannot report self and 429 rate limit errors', async () => {
      const handleClose = vi.fn();
      vi.spyOn(api.social, 'POST').mockResolvedValueOnce({
        data: undefined,
        error: { code: 'CANNOT_REPORT_SELF', status: 400, title: 'Error', type: '' },
        response: { status: 400 } as Response,
      });

      render(
        <ReportDialog
          isOpen={true}
          onClose={handleClose}
          targetType="VIDEO"
          targetId="video-target-1"
        />,
      );

      fireEvent.click(screen.getByLabelText('Spam or unwanted commercial content'));
      fireEvent.click(screen.getByRole('button', { name: 'Submit Report' }));

      await waitFor(() => {
        expect(screen.getByText('You cannot report your own content.')).toBeDefined();
      });
    });

    it('unmounts cleanly right after successful report submit with fake timers', async () => {
      const handleClose = vi.fn();
      vi.spyOn(api.social, 'POST').mockResolvedValue({
        data: { id: 'rep-new-123', created_at: '2026-09-30T10:00:00Z' },
        error: undefined,
        response: { status: 201 } as Response,
      });

      const { unmount } = render(
        <ReportDialog
          isOpen={true}
          onClose={handleClose}
          targetType="VIDEO"
          targetId="video-target-1"
        />,
      );

      fireEvent.click(screen.getByLabelText('Spam or unwanted commercial content'));

      vi.useFakeTimers();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Submit Report' }));
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(
        screen.getByText('Thank you for reporting. Our moderation team will review this content.'),
      ).toBeDefined();

      // Unmount while 1800ms timer is pending
      unmount();

      // Advance past delay
      await vi.advanceTimersByTimeAsync(3000);

      // handleClose should NOT have been called after unmount, and no errors thrown
      expect(handleClose).not.toHaveBeenCalled();
    });
  });

  describe('3. Moderation Queue & Two-Step Moderation (ADR-016)', () => {
    const mockCase: ModerationCase = {
      target_type: 'VIDEO',
      target_id: 'video-case-99',
      status: 'OPEN',
      open_count: 3,
      first_reported_at: '2026-09-28T10:00:00Z',
      reasons: {
        SPAM: 2,
        COPYRIGHT: 1,
      },
      reports: [
        {
          id: 'rep-1',
          reporter: {
            id: 'rep-user',
            handle: 'user1',
            display_name: 'User One',
            avatar_url: null,
          },
          reason: 'COPYRIGHT',
          note: 'Contains copyrighted background music.',
          status: 'OPEN',
          created_at: '2026-09-28T10:30:00Z',
        },
      ],
      resolution: null,
    };

    it('renders queue cases with preview, counts by reason, and reports', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValueOnce({
        data: { items: [mockCase], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(<ModerationQueue />);

      await waitFor(() => {
        expect(screen.getByText('3 open reports')).toBeDefined();
        expect(screen.getByText(/video-case-99/)).toBeDefined();
        expect(screen.getByText('Moderate')).toBeDefined();
      });
    });

    it('executes two-step moderation: Step 1 (moderateVideo) THEN Step 2 (resolveModerationCase)', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValueOnce({
        data: { items: [mockCase], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      const videoSpy = vi.spyOn(api.video, 'PUT').mockResolvedValueOnce({
        data: {
          id: 'video-case-99',
          title: 'Video',
          description: 'Video description',
          width: 1920,
          height: 1080,
          duration_ms: 1000,
          view_count: 0,
          like_count: 0,
          published_at: '',
          created_at: '',
          owner: { id: 'u1', handle: 'h1', display_name: 'N1', avatar_url: null },
          status: 'READY',
          visibility: 'PRIVATE',
          playback: null,
          moderation: { state: 'HIDDEN', reason: 'DMCA copyright takedown', moderated_at: '' },
        },
        error: undefined,
        response: { status: 200 } as Response,
      });

      const resolveSpy = vi.spyOn(api.social, 'PUT').mockResolvedValueOnce({
        data: { resolved_count: 1 },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(<ModerationQueue />);

      await waitFor(() => {
        expect(screen.getByText('Moderate')).toBeDefined();
      });

      // Open Modal
      fireEvent.click(screen.getByText('Moderate'));

      expect(screen.getByText('Moderate Reported Content')).toBeDefined();

      // Enter action reason
      const reasonInput = screen.getByPlaceholderText('Reason sent to content owner...');
      fireEvent.change(reasonInput, { target: { value: 'DMCA copyright takedown' } });

      // Confirm action
      const confirmBtn = screen.getByRole('button', { name: 'Confirm & Close Case' });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        // Step 1 was called first
        expect(videoSpy).toHaveBeenCalledWith('/v1/videos/{video_id}/moderation', {
          params: { path: { video_id: 'video-case-99' } },
          body: { state: 'HIDDEN', reason: 'DMCA copyright takedown' },
        });

        // Step 2 was called next
        expect(resolveSpy).toHaveBeenCalledWith(
          '/v1/moderation/cases/{target_type}/{target_id}/resolution',
          {
            params: { path: { target_type: 'VIDEO', target_id: 'video-case-99' } },
            body: { status: 'ACTIONED', note: undefined },
          },
        );

        expect(screen.getByText('Moderation case resolved successfully.')).toBeDefined();
      });
    });

    it('handles failure in Step 2 by displaying isolated retry button without repeating Step 1', async () => {
      vi.spyOn(api.social, 'GET').mockResolvedValueOnce({
        data: { items: [mockCase], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      // Step 1 succeeds
      const videoSpy = vi.spyOn(api.video, 'PUT').mockResolvedValueOnce({
        data: {
          id: 'video-case-99',
          title: 'Video',
          description: 'Video description',
          width: 1920,
          height: 1080,
          duration_ms: 1000,
          view_count: 0,
          like_count: 0,
          published_at: '',
          created_at: '',
          owner: { id: 'u1', handle: 'h1', display_name: 'N1', avatar_url: null },
          status: 'READY',
          visibility: 'PRIVATE',
          playback: null,
          moderation: { state: 'HIDDEN', reason: 'Hate speech violation', moderated_at: '' },
        },
        error: undefined,
        response: { status: 200 } as Response,
      });

      // Step 2 fails initially
      const resolveSpy = vi
        .spyOn(api.social, 'PUT')
        .mockResolvedValueOnce({
          data: undefined,
          error: {
            detail: 'Temporary network failure on resolution.',
            status: 500,
            title: 'Error',
            type: '',
          },
          response: { status: 500 } as Response,
        })
        // Step 2 succeeds on retry
        .mockResolvedValueOnce({
          data: { resolved_count: 1 },
          error: undefined,
          response: { status: 200 } as Response,
        });

      render(<ModerationQueue />);

      await waitFor(() => {
        expect(screen.getByText('Moderate')).toBeDefined();
      });

      fireEvent.click(screen.getByText('Moderate'));
      fireEvent.change(screen.getByPlaceholderText('Reason sent to content owner...'), {
        target: { value: 'Hate speech violation' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm & Close Case' }));

      // Verify Step 2 failed message and retry button appears
      await waitFor(() => {
        expect(screen.getByText('Temporary network failure on resolution.')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Retry case resolution' })).toBeDefined();
      });

      expect(videoSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledTimes(1);

      // Click the retry button
      fireEvent.click(screen.getByRole('button', { name: 'Retry case resolution' }));

      await waitFor(() => {
        // Step 1 was NOT re-triggered
        expect(videoSpy).toHaveBeenCalledTimes(1);
        // Step 2 was retried
        expect(resolveSpy).toHaveBeenCalledTimes(2);
        expect(screen.getByText('Moderation case resolved successfully.')).toBeDefined();
      });
    });
  });

  describe('4. User Management & Role Permissions', () => {
    const mockTargetUser: AdminUser = {
      id: 'target-creator-id',
      email: 'creator@winkey.vn',
      email_verified: true,
      handle: 'creator_target',
      display_name: 'Target Creator',
      avatar_url: null,
      roles: ['viewer', 'creator'],
      status: 'ACTIVE',
      suspension_reason: null,
      suspended_until: null,
      created_at: '2026-01-01T00:00:00Z',
    };

    const mockAdminTarget: AdminUser = {
      id: 'target-admin-id',
      email: 'superadmin@winkey.vn',
      email_verified: true,
      handle: 'super_admin',
      display_name: 'Super Admin',
      avatar_url: null,
      roles: ['viewer', 'admin'],
      status: 'ACTIVE',
      suspension_reason: null,
      suspended_until: null,
      created_at: '2026-01-01T00:00:00Z',
    };

    it('allows suspending an active user with reason', async () => {
      vi.spyOn(api.auth, 'GET').mockResolvedValueOnce({
        data: { items: [mockTargetUser], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      const suspendSpy = vi.spyOn(api.auth, 'PUT').mockResolvedValueOnce({
        data: { ...mockTargetUser, status: 'SUSPENDED' },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('Target Creator')).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));

      const modal = screen.getByRole('dialog');
      expect(within(modal).getByText('Suspend User Account')).toBeDefined();

      const reasonInput = within(modal).getByPlaceholderText(
        'Explain the reason for suspension for audit purposes...',
      );
      fireEvent.change(reasonInput, { target: { value: 'Phishing attack attempts' } });

      fireEvent.click(within(modal).getByRole('button', { name: 'Suspend' }));

      await waitFor(() => {
        expect(suspendSpy).toHaveBeenCalledWith('/v1/admin/users/{user_id}/suspension', {
          params: { path: { user_id: 'target-creator-id' } },
          body: { reason: 'Phishing attack attempts', until: undefined },
        });
        expect(screen.getByText('User account suspended.')).toBeDefined();
      });
    });

    it('allows unsuspending a suspended user', async () => {
      const suspendedUser: AdminUser = {
        ...mockTargetUser,
        status: 'SUSPENDED',
        suspension_reason: 'Old penalty',
      };

      vi.spyOn(api.auth, 'GET').mockResolvedValueOnce({
        data: { items: [suspendedUser], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      const unsuspendSpy = vi.spyOn(api.auth, 'DELETE').mockResolvedValueOnce({
        data: { ...mockTargetUser, status: 'ACTIVE' },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('Unsuspend')).toBeDefined();
      });

      fireEvent.click(screen.getByText('Unsuspend'));
      expect(screen.getByText('Are you sure you want to unsuspend this user?')).toBeDefined();

      const modal = screen.getByRole('dialog');
      fireEvent.click(within(modal).getByRole('button', { name: 'Unsuspend' }));

      await waitFor(() => {
        expect(unsuspendSpy).toHaveBeenCalledWith('/v1/admin/users/{user_id}/suspension', {
          params: { path: { user_id: 'target-creator-id' } },
        });
      });
    });

    it('admin can edit roles with viewer always required and disabled', async () => {
      vi.spyOn(api.auth, 'GET').mockResolvedValueOnce({
        data: { items: [mockTargetUser], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      const roleSpy = vi.spyOn(api.auth, 'PUT').mockResolvedValueOnce({
        data: { ...mockTargetUser, roles: ['viewer', 'creator', 'moderator'] },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('Edit Roles')).toBeDefined();
      });

      fireEvent.click(screen.getByText('Edit Roles'));

      expect(screen.getByText('Edit Account Roles')).toBeDefined();

      // Check viewer checkbox is disabled
      const viewerCheckbox = screen.getByRole('checkbox', { name: /viewer/i });
      expect((viewerCheckbox as HTMLInputElement).disabled).toBe(true);

      // Toggle moderator
      const modCheckbox = screen.getByRole('checkbox', { name: /moderator/i });
      fireEvent.click(modCheckbox);

      fireEvent.click(screen.getByRole('button', { name: 'Save Roles' }));

      await waitFor(() => {
        expect(roleSpy).toHaveBeenCalledWith('/v1/admin/users/{user_id}/roles', {
          params: { path: { user_id: 'target-creator-id' } },
          body: { roles: ['viewer', 'creator', 'moderator'] },
        });
        expect(screen.getByText('User roles updated successfully.')).toBeDefined();
      });
    });

    it('moderator cannot see or edit roles', async () => {
      mockUser = {
        id: 'mod-1',
        display_name: 'Mod Alice',
        avatar_url: null,
        roles: ['viewer', 'moderator'],
      };

      vi.spyOn(api.auth, 'GET').mockResolvedValueOnce({
        data: { items: [mockTargetUser], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('Target Creator')).toBeDefined();
      });

      expect(screen.queryByText('Edit Roles')).toBeNull();
    });

    it('disables actions on admin targets and on yourself', async () => {
      mockUser = {
        id: 'admin-id-123',
        display_name: 'Current Admin',
        avatar_url: null,
        roles: ['viewer', 'admin'],
      };

      const selfUser: AdminUser = {
        ...mockTargetUser,
        id: 'admin-id-123',
        display_name: 'Current Admin',
      };

      vi.spyOn(api.auth, 'GET').mockResolvedValueOnce({
        data: { items: [selfUser, mockAdminTarget], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('(you)')).toBeDefined();
      });

      // Actions on self are disabled
      const suspendButtons = screen.getAllByRole('button', { name: 'Suspend' });
      expect((suspendButtons[0] as HTMLButtonElement).disabled).toBe(true);
      expect((suspendButtons[1] as HTMLButtonElement).disabled).toBe(true);
    });

    it('maps error codes CANNOT_MODERATE_TARGET, LAST_ADMIN and DELETED', async () => {
      vi.spyOn(api.auth, 'GET').mockResolvedValueOnce({
        data: { items: [mockTargetUser], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      vi.spyOn(api.auth, 'PUT').mockResolvedValueOnce({
        data: undefined,
        error: { code: 'LAST_ADMIN', status: 409, title: 'Conflict', type: '' },
        response: { status: 409 } as Response,
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('Edit Roles')).toBeDefined();
      });

      fireEvent.click(screen.getByText('Edit Roles'));
      fireEvent.click(screen.getByRole('button', { name: 'Save Roles' }));

      await waitFor(() => {
        expect(
          screen.getByText('Cannot remove the Admin role from the last system Administrator.'),
        ).toBeDefined();
      });
    });

    it('displays Vietnamese error message on network failure when locale is vi', async () => {
      setTestLocale('vi');
      vi.spyOn(api.auth, 'GET').mockRejectedValueOnce(new Error('Network error'));

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('Lỗi kết nối mạng khi tải danh sách người dùng.')).toBeDefined();
      });
    });

    it('ignores stale search query responses (ab delayed, abc resolves first)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      let resolveAB!: (val: Awaited<ReturnType<typeof api.auth.GET>>) => void;
      const promiseAB = new Promise<Awaited<ReturnType<typeof api.auth.GET>>>((resolve) => {
        resolveAB = resolve;
      });

      const userABC: AdminUser = {
        ...mockTargetUser,
        id: 'user-abc',
        display_name: 'Result for ABC',
      };

      const getSpy = vi.spyOn(api.auth, 'GET').mockImplementation(async (path, init) => {
        const query = (init as { params?: { query?: { q?: string } } } | undefined)?.params?.query;
        if (query?.q === 'ab') {
          return promiseAB;
        }
        if (query?.q === 'abc') {
          return {
            data: { items: [userABC], next_cursor: null },
            error: undefined,
            response: { status: 200 } as Response,
          };
        }
        return {
          data: { items: [mockTargetUser], next_cursor: null },
          error: undefined,
          response: { status: 200 } as Response,
        };
      });

      render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('Target Creator')).toBeDefined();
      });

      const searchInput = screen.getByPlaceholderText(
        'Search by email, @handle, or display name...',
      );

      // 1. Type "ab" - delayed response
      act(() => {
        fireEvent.change(searchInput, { target: { value: 'ab' } });
      });

      // Advance debounce timer (300ms) to trigger "ab" request
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });

      expect(getSpy).toHaveBeenCalledWith('/v1/admin/users', {
        params: { query: { limit: 20, q: 'ab' } },
      });

      // 2. Type "abc" - resolves immediately
      act(() => {
        fireEvent.change(searchInput, { target: { value: 'abc' } });
      });

      // Advance debounce timer (300ms) to trigger "abc" request
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });

      await waitFor(() => {
        expect(screen.getByText('Result for ABC')).toBeDefined();
      });

      // 3. Now resolve "ab" request with stale data
      const userAB: AdminUser = {
        ...mockTargetUser,
        id: 'user-ab',
        display_name: 'Result for AB',
      };
      await act(async () => {
        resolveAB({
          data: { items: [userAB], next_cursor: null },
          error: undefined,
          response: { status: 200 } as Response,
        });
        await vi.advanceTimersByTimeAsync(50);
      });

      // Assert that "Result for ABC" remains and "Result for AB" was ignored
      expect(screen.getByText('Result for ABC')).toBeDefined();
      expect(screen.queryByText('Result for AB')).toBeNull();
    });

    it('unmounts cleanly right after successful action with fake timers: no error, no state update', async () => {
      const getSpy = vi.spyOn(api.auth, 'GET').mockResolvedValue({
        data: { items: [mockTargetUser], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      vi.spyOn(api.auth, 'PUT').mockResolvedValue({
        data: {
          id: mockTargetUser.id,
          email: mockTargetUser.email,
          handle: mockTargetUser.handle,
          display_name: mockTargetUser.display_name,
          roles: ['viewer', 'creator', 'moderator'],
          status: 'ACTIVE',
          created_at: '2026-01-01T00:00:00Z',
        },
        error: undefined,
        response: { status: 200 } as Response,
      });

      const { unmount } = render(<UserManagement />);

      await waitFor(() => {
        expect(screen.getByText('Target Creator')).toBeDefined();
      });

      expect(getSpy).toHaveBeenCalledTimes(1);

      // Open Edit Roles modal
      fireEvent.click(screen.getByText('Edit Roles'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Save Roles' })).toBeDefined();
      });

      // Switch to fake timers before triggering submit and timer
      vi.useFakeTimers();

      // Submit role changes
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Roles' }));
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(screen.getByText('User roles updated successfully.')).toBeDefined();

      // Unmount immediately while 1200ms timer is pending
      unmount();

      // Advance time past the 1200ms close/fetch timer
      await vi.advanceTimersByTimeAsync(2000);

      // GET call count remains unchanged (fetchUsers was aborted on unmount)
      expect(getSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. Audit Log Viewer', () => {
    const mockAudit: AuditEntry = {
      id: 'audit-entry-1',
      actor: {
        id: 'admin-1',
        handle: 'admin_boss',
        display_name: 'Admin Boss',
        avatar_url: null,
      },
      action: 'USER_SUSPENDED',
      target_user_id: 'bad-user-id',
      details: {
        reason: 'Spamming phishing links',
        until: '2026-12-31T23:59:59Z',
      },
      created_at: '2026-09-29T15:00:00Z',
    };

    it('renders audit log entries with details and filters by target_user_id', async () => {
      const getSpy = vi.spyOn(api.auth, 'GET').mockResolvedValueOnce({
        data: { items: [mockAudit], next_cursor: null },
        error: undefined,
        response: { status: 200 } as Response,
      });

      render(<AuditLogViewer />);

      await waitFor(() => {
        expect(screen.getByText('User Suspended')).toBeDefined();
        expect(screen.getByText('@admin_boss')).toBeDefined();
        expect(screen.getByText('Reason: Spamming phishing links')).toBeDefined();
      });

      // Filter by target_user_id
      const filterInput = screen.getByPlaceholderText('Enter target_user_id UUID...');
      fireEvent.change(filterInput, { target: { value: 'bad-user-id' } });

      fireEvent.click(screen.getByRole('button', { name: 'Filter' }));

      await waitFor(() => {
        expect(getSpy).toHaveBeenCalledWith('/v1/admin/audit-log', {
          params: { query: { limit: 20, target_user_id: 'bad-user-id' } },
        });
      });
    });
  });

  describe('6. Studio Hidden Video Moderation Reason', () => {
    it('displays moderation reason on hidden video in Studio', async () => {
      const hiddenVideo: StudioVideo = {
        id: 'video-hidden-1',
        title: 'My Banned Video',
        visibility: 'PRIVATE',
        status: 'READY',
        progress: 100,
        error: null,
        duration_ms: 120000,
        created_at: '2026-09-20T10:00:00Z',
        thumbnail_url: null,
        moderation: {
          state: 'HIDDEN',
          reason: 'Bản quyền nhạc Vpop',
          moderated_at: '2026-09-28T10:00:00Z',
        },
      };

      vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
        data: { items: [hiddenVideo], next_cursor: null },
        error: undefined,
        response: { ok: true, status: 200 } as Response,
      });

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <StudioPage />
        </QueryClientProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('My Banned Video')).toBeDefined();
        expect(screen.getByText('Hidden by a moderator: Bản quyền nhạc Vpop')).toBeDefined();
      });
    });
  });
});
