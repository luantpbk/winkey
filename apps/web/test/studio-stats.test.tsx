import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StudioAnalyticsPage from '../src/app/[locale]/studio/analytics/page';
import StudioVideoAnalyticsPage from '../src/app/[locale]/studio/videos/[id]/analytics/page';
import { StatsChart } from '../src/components/studio/stats-chart';
import { TopVideosTable } from '../src/components/studio/top-videos-table';
import { StatsFooter } from '../src/components/studio/stats-footer';
import {
  formatVietnamDate,
  getStatsDateRange,
  formatStarts,
  formatWatchTime,
  formatAvgWatchTime,
  formatRebufferRatio,
  formatStartupMs,
  formatRefreshedAt,
} from '../src/lib/analytics/stats-utils';
import type { ChannelStatsTopVideo, ChannelStatsDay, VideoStatsDay } from '@winkey/api-client';
import {
  setMockStatsRateLimit,
  setMockStatsEmpty,
  resetStatsMocks,
  setMockCurrentUser,
} from '../src/mocks/handlers';
import { mockUsers } from '../src/mocks/fixtures';
import { server } from '../src/mocks/server';
import { tokenStore } from '../src/lib/auth/token-store';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

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

// --- Router & Params Mock ---
const mockPush = vi.fn();
let mockParamsId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10';

vi.mock('next/navigation', () => ({
  useParams: () => ({
    id: mockParamsId,
    locale: 'vi',
  }),
  useRouter: () => ({
    push: mockPush,
  }),
  usePathname: () => `/studio/videos/${mockParamsId}/analytics`,
}));

vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => `/studio/videos/${mockParamsId}/analytics`,
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
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

// --- Auth Context Mock ---
let mockIsAuthenticated = true;
let mockIsAuthLoading = false;

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockIsAuthenticated ? mockUsers.creator : null,
    isLoading: mockIsAuthLoading,
    logout: vi.fn(),
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('Studio Creator Statistics (Task R1-b-web)', () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'bypass' });
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    resetStatsMocks();
    setMockCurrentUser(mockUsers.creator);
    tokenStore.set(`mock-access-${mockUsers.creator.id}`);
    mockIsAuthenticated = true;
    mockIsAuthLoading = false;
    mockParamsId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10';
    vi.clearAllMocks();
  });

  afterEach(() => {
    server.resetHandlers();
    resetStatsMocks();
    tokenStore.clear();
  });

  // ==========================================
  // Criteria 1: Date Range & Asia/Ho_Chi_Minh
  // ==========================================
  describe('Criteria 1: Date Range in Asia/Ho_Chi_Minh', () => {
    it('calculates 7, 28, and 90 day ranges correctly in Asia/Ho_Chi_Minh', () => {
      // Reference date: 2026-10-15 12:00:00 UTC (19:00 in Vietnam)
      const now = new Date('2026-10-15T12:00:00Z');

      const range7 = getStatsDateRange(7, now);
      expect(range7.to).toBe('2026-10-15');
      expect(range7.from).toBe('2026-10-09'); // 7 days: 09, 10, 11, 12, 13, 14, 15

      const range28 = getStatsDateRange(28, now);
      expect(range28.to).toBe('2026-10-15');
      expect(range28.from).toBe('2026-09-18'); // 28 days

      const range90 = getStatsDateRange(90, now);
      expect(range90.to).toBe('2026-10-15');
      expect(range90.from).toBe('2026-07-18'); // 90 days
    });

    it('correctly computes Vietnam calendar date when browser is in UTC-8 near midnight', () => {
      // In Los Angeles (UTC-8 / PDT UTC-7), near midnight:
      // When it is 2026-10-01 23:30:00 -08:00 (which is 2026-10-02 07:30:00 UTC),
      // in Vietnam (UTC+7), it is already 2026-10-02 14:30:00.
      const dateInUtcMinus8 = new Date('2026-10-01T23:30:00-08:00');

      const vietnamDateStr = formatVietnamDate(dateInUtcMinus8);
      expect(vietnamDateStr).toBe('2026-10-02');

      const range = getStatsDateRange(7, dateInUtcMinus8);
      expect(range.to).toBe('2026-10-02');
      expect(range.from).toBe('2026-09-26');
    });

    it('correctly handles early morning in Vietnam when UTC is previous day', () => {
      // When it is 2026-10-02 01:15:00 +07:00 in Vietnam,
      // UTC is 2026-10-01 18:15:00 UTC.
      const morningInVietnam = new Date('2026-10-01T18:15:00Z');

      const vietnamDateStr = formatVietnamDate(morningInVietnam);
      expect(vietnamDateStr).toBe('2026-10-02');

      const range = getStatsDateRange(7, morningInVietnam);
      expect(range.to).toBe('2026-10-02');
      expect(range.from).toBe('2026-09-26');
    });
  });

  // ==========================================
  // Criteria 2: Formatting of Null Ratios, Averages, Zeroes (No NaN)
  // ==========================================
  describe('Criteria 2: Formatting of Null Ratios, Averages, and No NaN', () => {
    it('formats null average watch time as "—" and valid ms as "m:ss"', () => {
      expect(formatAvgWatchTime(null)).toBe('—');
      expect(formatAvgWatchTime(0)).toBe('0:00');
      expect(formatAvgWatchTime(65_000)).toBe('1:05');
      expect(formatAvgWatchTime(125_000)).toBe('2:05');
      expect(formatAvgWatchTime(NaN)).toBe('—');
    });

    it('formats null rebuffer ratio as "—" and valid ratio as percentage', () => {
      expect(formatRebufferRatio(null)).toBe('—');
      expect(formatRebufferRatio(0)).toBe('0.0%');
      expect(formatRebufferRatio(0.008)).toBe('0.8%');
      expect(formatRebufferRatio(0.125)).toBe('12.5%');
      expect(formatRebufferRatio(NaN)).toBe('—');
    });

    it('formats null startup latencies as "—" and valid ms as "${n} ms"', () => {
      expect(formatStartupMs(null)).toBe('—');
      expect(formatStartupMs(0)).toBe('0 ms');
      expect(formatStartupMs(340)).toBe('340 ms');
      expect(formatStartupMs(NaN)).toBe('—');
    });

    it('formats watch time as "h:mm" and zero as "0:00"', () => {
      expect(formatWatchTime(0)).toBe('0:00');
      expect(formatWatchTime(null as any)).toBe('0:00');
      expect(formatWatchTime(120_000)).toBe('0:02');
      expect(formatWatchTime(3_600_000)).toBe('1:00');
      expect(formatWatchTime(5_400_000)).toBe('1:30');
      expect(formatWatchTime(36_000_000)).toBe('10:00');
    });

    it('formats starts with locale separators and handles 0', () => {
      expect(formatStarts(0)).toBe('0');
      expect(formatStarts(1250)).toBe('1.250');
      expect(formatStarts(1000000)).toBe('1.000.000');
    });

    it('formats refreshed_at correctly or shows "Chưa có dữ liệu" when null', () => {
      expect(formatRefreshedAt(null)).toBeNull();
      render(<StatsFooter refreshedAt={null} />);
      expect(screen.getByText('Chưa có dữ liệu')).toBeDefined();

      const formatted = formatRefreshedAt('2026-09-30T12:00:00Z');
      expect(formatted).not.toBeNull();
      expect(formatted).toContain('2026');
    });
  });

  // ==========================================
  // Criteria 3: Daily Chart Renders Every Day in `days`
  // ==========================================
  describe('Criteria 3: Daily Chart Renders Every Day in days', () => {
    it('renders a circle point for every day in the days array', () => {
      const mockDays: ChannelStatsDay[] = [
        { day: '2026-09-24', starts: 10, watch_time_ms: 600000, rebuffer_ratio: 0.01 },
        { day: '2026-09-25', starts: 20, watch_time_ms: 1200000, rebuffer_ratio: 0.02 },
        { day: '2026-09-26', starts: 0, watch_time_ms: 0, rebuffer_ratio: null },
        { day: '2026-09-27', starts: 15, watch_time_ms: 900000, rebuffer_ratio: 0.01 },
        { day: '2026-09-28', starts: 25, watch_time_ms: 1500000, rebuffer_ratio: 0.015 },
        { day: '2026-09-29', starts: 30, watch_time_ms: 1800000, rebuffer_ratio: 0.02 },
        { day: '2026-09-30', starts: 40, watch_time_ms: 2400000, rebuffer_ratio: 0.01 },
      ];

      render(<StatsChart days={mockDays} />);

      const chart = screen.getByTestId('stats-daily-chart');
      expect(chart).toBeDefined();

      // Ensure every single day has its corresponding point element
      for (const d of mockDays) {
        const point = screen.getByTestId(`chart-point-${d.day}`);
        expect(point).toBeDefined();
      }
    });

    it('allows toggling between metrics and shows tooltip on hover', () => {
      const mockDays: VideoStatsDay[] = [
        {
          day: '2026-09-29',
          starts: 50,
          watch_time_ms: 3000000,
          viewers: 42,
          rebuffer_ratio: 0.01,
          startup_p50_ms: 250,
          startup_p95_ms: 800,
        },
        {
          day: '2026-09-30',
          starts: 80,
          watch_time_ms: 4800000,
          viewers: 65,
          rebuffer_ratio: 0.02,
          startup_p50_ms: 300,
          startup_p95_ms: 900,
        },
      ];

      render(<StatsChart days={mockDays} showViewers={true} />);

      // Switch to watch time tab
      const watchTimeTab = screen.getByTestId('chart-tab-watch-time');
      fireEvent.click(watchTimeTab);

      // Switch to viewers tab
      const viewersTab = screen.getByTestId('chart-tab-viewers');
      fireEvent.click(viewersTab);

      // Hover over point to verify tooltip
      const point = screen.getByTestId('chart-point-2026-09-30');
      fireEvent.mouseEnter(point);

      const tooltip = screen.getByTestId('chart-tooltip');
      expect(tooltip).toBeDefined();
      expect(tooltip.textContent).toContain('2026-09-30');
      expect(tooltip.textContent).toContain('Người xem: 65');

      fireEvent.mouseLeave(point);
      expect(screen.queryByTestId('chart-tooltip')).toBeNull();
    });
  });

  // ==========================================
  // Criteria 4: Top-10 Table Links to Video Analytics
  // ==========================================
  describe('Criteria 4: Top-10 Table Links', () => {
    it('renders ranked videos with links to their per-video analytics page', () => {
      const mockTopVideos: ChannelStatsTopVideo[] = [
        {
          video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
          title: 'Kiến trúc Microservices Video Streaming',
          starts: 2540,
          watch_time_ms: 360000000, // 100 hours
        },
        {
          video_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11',
          title: 'Lập trình Go cơ bản',
          starts: 1200,
          watch_time_ms: 180000000, // 50 hours
        },
      ];

      render(<TopVideosTable videos={mockTopVideos} />);

      const table = screen.getByTestId('top-videos-table');
      expect(table).toBeDefined();

      const link1 = screen.getByTestId('top-video-link-0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10');
      expect(link1.getAttribute('href')).toBe(
        '/studio/videos/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10/analytics',
      );
      expect(link1.textContent).toContain('Kiến trúc Microservices Video Streaming');

      const link2 = screen.getByTestId('top-video-link-0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11');
      expect(link2.getAttribute('href')).toBe(
        '/studio/videos/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11/analytics',
      );
      expect(link2.textContent).toContain('Lập trình Go cơ bản');
    });

    it('renders empty message when top videos list is empty', () => {
      render(<TopVideosTable videos={[]} />);
      expect(
        screen.getByText('Không có video nào có lượt phát trong khoảng thời gian này.'),
      ).toBeDefined();
    });
  });

  // ==========================================
  // Criteria 5: 404 and 429 States
  // ==========================================
  describe('Criteria 5: 404 and 429 Error States', () => {
    it('shows 429 rate limit alert with retry button on channel stats page', async () => {
      setMockStatsRateLimit(true);

      renderWithProviders(<StudioAnalyticsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('stats-error-429')).toBeDefined();
      });

      expect(screen.getByText('Quá nhiều yêu cầu')).toBeDefined();
      expect(screen.getByText('Thử lại')).toBeDefined();
    });

    it('shows 429 rate limit alert with retry button on video stats page', async () => {
      setMockStatsRateLimit(true);

      renderWithProviders(<StudioVideoAnalyticsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('stats-error-429')).toBeDefined();
      });

      expect(screen.getByText('Quá nhiều yêu cầu')).toBeDefined();
    });

    it('shows 404 video not found error on video stats page for invalid or non-owned video', async () => {
      mockParamsId = 'non-existent-video-id-999';

      renderWithProviders(<StudioVideoAnalyticsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('stats-error-404')).toBeDefined();
      });

      const card404 = screen.getByTestId('stats-error-404');
      expect(card404).toBeDefined();
      expect(screen.getByText('Không tìm thấy video')).toBeDefined();
      expect(screen.getAllByText('Quay lại Studio').length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================
  // Criteria 6: Auth Guard (Never Call API Without Auth)
  // ==========================================
  describe('Criteria 6: Auth Guard', () => {
    it('does not load channel stats and prompts for login when unauthenticated', async () => {
      mockIsAuthenticated = false;
      tokenStore.clear();

      renderWithProviders(<StudioAnalyticsPage />);

      expect(screen.getByText('Yêu cầu đăng nhập')).toBeDefined();
      expect(
        screen.getByText('Vui lòng đăng nhập tài khoản Creator để xem số liệu thống kê Studio.'),
      ).toBeDefined();

      // Ensure no stats chart or tables rendered
      expect(screen.queryByTestId('stats-daily-chart')).toBeNull();
      expect(screen.queryByTestId('top-videos-table')).toBeNull();
    });

    it('does not load video stats and prompts for login when unauthenticated', async () => {
      mockIsAuthenticated = false;
      tokenStore.clear();

      renderWithProviders(<StudioVideoAnalyticsPage />);

      expect(screen.getByText('Yêu cầu đăng nhập')).toBeDefined();
      expect(
        screen.getByText('Vui lòng đăng nhập để xem số liệu thống kê của video này.'),
      ).toBeDefined();

      // Ensure no stats chart rendered
      expect(screen.queryByTestId('stats-daily-chart')).toBeNull();
    });
  });
});
