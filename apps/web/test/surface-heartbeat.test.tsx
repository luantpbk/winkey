import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  buildWatchUrl,
  parseWatchSurface,
  stripWatchSurfaceFromAddressBar,
  VALID_WATCH_SURFACES,
  type WatchSurface,
} from '../src/lib/video/watch-url';
import { PlaybackTracker, type PlaybackTrackerOptions } from '../src/lib/video/playback-tracker';
import { VideoPlayer } from '../src/components/video/video-player';
import { VideoCard } from '../src/components/video/video-card';
import { VideoFeed } from '../src/components/video/video-feed';
import { RelatedVideoCard } from '../src/components/video/related-videos-column';
import { getNotificationUrl } from '../src/components/notifications/notification-item';
import type { VideoSummary, Notification, PlaybackHeartbeatBatch } from '@winkey/api-client';

// Track PlaybackTracker instantiations for testing
let recordedTrackers: Array<{ videoId: string; surface?: WatchSurface; playbackId: string }> = [];

vi.mock('../src/lib/video/playback-tracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/video/playback-tracker')>();
  return {
    ...actual,
    PlaybackTracker: class extends actual.PlaybackTracker {
      constructor(options: PlaybackTrackerOptions) {
        super(options);
        recordedTrackers.push({
          videoId: options.videoId,
          surface: options.surface,
          playbackId: options.playbackId,
        });
      }
    },
  };
});

// Mock routing & next-intl
vi.mock('../src/i18n/routing', () => ({
  Link: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/watch/v-test',
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (params?.count !== undefined) return `${params.count} ${key}`;
    return key;
  },
  useLocale: () => 'vi',
}));

// Mock auth context
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    clearSession: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock toast
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

// Mock Hls.js
vi.mock('hls.js', () => {
  const isSupportedMock = vi.fn().mockReturnValue(true);
  const HlsMock = vi.fn().mockImplementation(() => ({
    loadSource: vi.fn(),
    attachMedia: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
    startLoad: vi.fn(),
    recoverMediaError: vi.fn(),
    currentLevel: -1,
    levels: [],
  }));
  (HlsMock as unknown as Record<string, unknown>).isSupported = isSupportedMock;
  (HlsMock as unknown as Record<string, unknown>).Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    ERROR: 'hlsError',
  };
  (HlsMock as unknown as Record<string, unknown>).ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
  };
  return { default: HlsMock };
});

// Mock api-client
vi.mock('../src/lib/api-client', () => ({
  api: {
    video: {
      GET: vi.fn().mockResolvedValue({ data: null, response: new Response(null, { status: 200 }) }),
      POST: vi
        .fn()
        .mockResolvedValue({ data: null, response: new Response(null, { status: 200 }) }),
    },
    social: {
      GET: vi.fn().mockResolvedValue({ data: null, response: new Response(null, { status: 200 }) }),
    },
  },
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

const mockVideoSummary: VideoSummary = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
  title: 'Thử nghiệm hệ thống phát video',
  duration_ms: 120000,
  thumbnail_url: 'https://cdn.winkey.vn/thumb.jpg',
  view_count: 1500,
  published_at: '2026-10-01T00:00:00Z',
  owner: {
    id: '0192f5e4-7c1a-7b3e-9d2a-user1',
    display_name: 'Winkey Official',
    handle: 'winkey',
    avatar_url: 'https://cdn.winkey.vn/avatar.jpg',
  },
};

describe('ADR-030 / R2-ab-web: Surface telemetry & watch link builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedTrackers = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    recordedTrackers = [];
  });

  describe('1. Shared Helper: buildWatchUrl & parseWatchSurface', () => {
    it('builds watch URLs with surface query parameter (?src=<surface>)', () => {
      expect(buildWatchUrl('vid-123', 'for_you')).toBe('/watch/vid-123?src=for_you');
      expect(buildWatchUrl('vid-123', 'latest')).toBe('/watch/vid-123?src=latest');
      expect(buildWatchUrl('vid-123', 'trending')).toBe('/watch/vid-123?src=trending');
      expect(buildWatchUrl('vid-123', 'up_next')).toBe('/watch/vid-123?src=up_next');
      expect(buildWatchUrl('vid-123', 'search')).toBe('/watch/vid-123?src=search');
      expect(buildWatchUrl('vid-123', 'subscriptions')).toBe('/watch/vid-123?src=subscriptions');
      expect(buildWatchUrl('vid-123', 'channel')).toBe('/watch/vid-123?src=channel');
      expect(buildWatchUrl('vid-123', 'playlist')).toBe('/watch/vid-123?src=playlist');
      expect(buildWatchUrl('vid-123', 'other')).toBe('/watch/vid-123?src=other');
    });

    it('builds clean URL without ?src when surface is omitted', () => {
      expect(buildWatchUrl('vid-123')).toBe('/watch/vid-123');
    });

    it('preserves extra query parameters alongside ?src', () => {
      const url = buildWatchUrl('vid-123', 'other', {
        comment: 'comm-abc',
        t: 45,
      });
      expect(url).toBe('/watch/vid-123?comment=comm-abc&t=45&src=other');
    });

    it('parses valid surfaces and falls back to other for invalid or null', () => {
      for (const surface of VALID_WATCH_SURFACES) {
        expect(parseWatchSurface(surface)).toBe(surface);
      }
      expect(parseWatchSurface('external_promo')).toBe('other');
      expect(parseWatchSurface('random_source')).toBe('other');
      expect(parseWatchSurface('')).toBe('other');
      expect(parseWatchSurface(null)).toBe('other');
      expect(parseWatchSurface(undefined)).toBe('other');
    });

    it('strips ?src from address bar via history.replaceState and returns the surface', () => {
      const originalHref = window.location.href;
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      // Set URL with src and an extra query param
      window.history.pushState(
        {},
        '',
        '/vi/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10?src=for_you&t=30#overview',
      );

      const resolved = stripWatchSurfaceFromAddressBar();
      expect(resolved).toBe('for_you');
      expect(replaceStateSpy).toHaveBeenCalledTimes(1);

      // Verify the new URL in replaceState has no ?src, but preserves ?t=30 and #overview
      const callArgs = replaceStateSpy.mock.calls[0];
      expect(callArgs[2]).toBe('/vi/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10?t=30#overview');

      // Cleanup
      window.history.pushState({}, '', originalHref);
    });

    it('strips unknown ?src from address bar and returns other', () => {
      const originalHref = window.location.href;
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.history.pushState(
        {},
        '',
        '/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10?src=malicious_tag',
      );

      const resolved = stripWatchSurfaceFromAddressBar();
      expect(resolved).toBe('other');
      expect(replaceStateSpy).toHaveBeenCalledWith(
        window.history.state,
        '',
        '/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10',
      );

      window.history.pushState({}, '', originalHref);
    });
  });

  describe('2. Surface Links across all entry points', () => {
    it('VideoCard renders link with specified surface', () => {
      const { container } = renderWithClient(
        <VideoCard video={mockVideoSummary} surface="for_you" />,
      );
      const links = container.querySelectorAll<HTMLAnchorElement>('a[href*="/watch/"]');
      expect(links.length).toBeGreaterThan(0);
      links.forEach((a) => {
        expect(a.getAttribute('href')).toBe(`/watch/${mockVideoSummary.id}?src=for_you`);
      });
    });

    it('VideoFeed with surface passes it down to rendered VideoCards', async () => {
      const fetchPageMock = vi.fn().mockResolvedValue({
        items: [mockVideoSummary],
        next_cursor: null,
      });

      renderWithClient(
        <VideoFeed
          queryKey={['test-feed-trending']}
          fetchPage={fetchPageMock}
          surface="trending"
        />,
      );

      const card = await screen.findByText(mockVideoSummary.title);
      expect(card).toBeDefined();

      const watchLinks = document.querySelectorAll<HTMLAnchorElement>(
        `a[href*="/watch/${mockVideoSummary.id}"]`,
      );
      expect(watchLinks.length).toBeGreaterThan(0);
      watchLinks.forEach((link) => {
        expect(link.getAttribute('href')).toBe(`/watch/${mockVideoSummary.id}?src=trending`);
      });
    });

    it('RelatedVideoCard renders links with src=up_next', () => {
      const { container } = renderWithClient(
        <RelatedVideoCard video={mockVideoSummary} locale="vi" />,
      );
      const watchLinks = container.querySelectorAll<HTMLAnchorElement>(
        `a[href*="/watch/${mockVideoSummary.id}"]`,
      );
      expect(watchLinks.length).toBeGreaterThan(0);
      watchLinks.forEach((link) => {
        expect(link.getAttribute('href')).toBe(`/watch/${mockVideoSummary.id}?src=up_next`);
      });
    });

    it('NotificationItem URLs carry src=other', () => {
      const notifComment: Notification = {
        id: 'notif-1',
        kind: 'VIDEO_COMMENT',
        actor: { id: 'u2', display_name: 'Bob', handle: 'bob', avatar_url: null },
        video_id: 'vid-123',
        comment_id: 'com-456',
        created_at: '2026-10-01T00:00:00Z',
        read_at: null,
      };
      const notifPublished: Notification = {
        id: 'notif-2',
        kind: 'VIDEO_PUBLISHED',
        actor: { id: 'u3', display_name: 'Alice', handle: 'alice', avatar_url: null },
        video_id: 'vid-789',
        comment_id: null,
        created_at: '2026-10-01T00:00:00Z',
        read_at: null,
      };

      expect(getNotificationUrl(notifComment)).toBe('/watch/vid-123?comment=com-456&src=other');
      expect(getNotificationUrl(notifPublished)).toBe('/watch/vid-789?src=other');
    });
  });

  describe('3. PlaybackTracker surface propagation', () => {
    it('sends the configured surface on start, heartbeat, and end samples', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: mockVideoSummary.id,
        playbackId: 'test-playback-1',
        surface: 'for_you',
        transport: mockTransport,
        heartbeatIntervalMs: 500,
      });

      // 1. First frame -> start sample
      tracker.recordPlaying(0);
      await Promise.resolve();

      expect(sentBatches).toHaveLength(1);
      expect(sentBatches[0].samples[0].kind).toBe('start');
      expect(sentBatches[0].samples[0].surface).toBe('for_you');

      // 2. Play some time & trigger heartbeat
      tracker.recordTimeUpdate(2);
      await tracker.flush();

      // 3. Playback ends -> end sample
      tracker.recordEnded(10);
      await Promise.resolve();

      const lastBatch = sentBatches[sentBatches.length - 1];
      const endSample = lastBatch.samples.find((s) => s.kind === 'end');
      expect(endSample).toBeDefined();
      expect(endSample?.surface).toBe('for_you');

      // Verify every single sample emitted has surface === 'for_you'
      for (const batch of sentBatches) {
        for (const sample of batch.samples) {
          expect(sample.surface).toBe('for_you');
        }
      }

      tracker.destroy();
    });

    it('defaults to surface=other when surface is omitted or undefined', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: mockVideoSummary.id,
        playbackId: 'test-playback-anon',
        transport: mockTransport,
      });

      tracker.recordPlaying(0);
      await Promise.resolve();

      expect(sentBatches[0].samples[0].surface).toBe('other');
      tracker.destroy();
    });

    it('preserves surface on synchronous flushSync (pagehide / unload)', () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: mockVideoSummary.id,
        playbackId: 'test-playback-sync',
        surface: 'up_next',
        transport: mockTransport,
      });

      tracker.recordPlaying(0);
      // Simulate unload flush
      tracker.handlePageHide();

      expect(sentBatches.length).toBeGreaterThan(0);
      for (const batch of sentBatches) {
        for (const sample of batch.samples) {
          expect(sample.surface).toBe('up_next');
        }
      }

      tracker.destroy();
    });
  });

  describe('4. Watch Page VideoPlayer surface lifecycle', () => {
    it('strips ?src from address bar on mount and sends that surface on heartbeats', async () => {
      const originalHref = window.location.href;
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      // Set URL as if user arrived from the "Dành cho bạn" feed
      window.history.pushState({}, '', `/watch/${mockVideoSummary.id}?src=for_you`);

      // Render VideoPlayer without explicit surface prop (simulating real watch page)
      const { unmount } = renderWithClient(
        <VideoPlayer
          videoId={mockVideoSummary.id}
          durationMs={mockVideoSummary.duration_ms}
          src="https://cdn.winkey.vn/video.m3u8"
          title={mockVideoSummary.title}
        />,
      );

      // 1. Address bar was stripped before any media event
      expect(replaceStateSpy).toHaveBeenCalledWith(
        window.history.state,
        '',
        `/watch/${mockVideoSummary.id}`,
      );

      // 2. PlaybackTracker was instantiated with resolved surface='for_you'
      expect(recordedTrackers).toHaveLength(1);
      expect(recordedTrackers[0].videoId).toBe(mockVideoSummary.id);
      expect(recordedTrackers[0].surface).toBe('for_you');

      unmount();
      window.history.pushState({}, '', originalHref);
    });

    it('navigating to a second video starts a new playback with its own surface', async () => {
      const originalHref = window.location.href;
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      // 1. Initial video from "for_you" feed
      window.history.pushState({}, '', `/watch/video-1?src=for_you`);

      const { rerender, unmount } = renderWithClient(
        <VideoPlayer
          videoId="video-1"
          durationMs={60000}
          src="https://cdn.winkey.vn/v1.m3u8"
          title="Video 1"
        />,
      );

      expect(replaceStateSpy).toHaveBeenLastCalledWith(window.history.state, '', '/watch/video-1');
      expect(recordedTrackers).toHaveLength(1);
      expect(recordedTrackers[0]).toMatchObject({
        videoId: 'video-1',
        surface: 'for_you',
      });

      // 2. User clicks "up_next" in RelatedVideosColumn -> address bar updates to video-2?src=up_next
      window.history.pushState({}, '', `/watch/video-2?src=up_next`);

      // VideoPlayer receives new videoId prop
      rerender(
        <VideoPlayer
          videoId="video-2"
          durationMs={90000}
          src="https://cdn.winkey.vn/v2.m3u8"
          title="Video 2"
        />,
      );

      // New video strips its own ?src=up_next
      expect(replaceStateSpy).toHaveBeenLastCalledWith(window.history.state, '', '/watch/video-2');

      // Second video has its own tracker with surface='up_next' and different playbackId
      expect(recordedTrackers).toHaveLength(2);
      expect(recordedTrackers[1]).toMatchObject({
        videoId: 'video-2',
        surface: 'up_next',
      });
      expect(recordedTrackers[0].playbackId).not.toBe(recordedTrackers[1].playbackId);

      unmount();
      window.history.pushState({}, '', originalHref);
    });

    it('unknown surface on watch page falls back to other and strips invalid tag from URL', async () => {
      const originalHref = window.location.href;
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.history.pushState({}, '', `/watch/video-3?src=unrecognized_tag`);

      const { unmount } = renderWithClient(
        <VideoPlayer
          videoId="video-3"
          durationMs={60000}
          src="https://cdn.winkey.vn/v3.m3u8"
          title="Video 3"
        />,
      );

      expect(replaceStateSpy).toHaveBeenCalledWith(window.history.state, '', '/watch/video-3');

      expect(recordedTrackers).toHaveLength(1);
      expect(recordedTrackers[0]).toMatchObject({
        videoId: 'video-3',
        surface: 'other',
      });

      unmount();
      window.history.pushState({}, '', originalHref);
    });
  });
});
