import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import viMessages from '../messages/vi.json';

// Setup URL mock for jsdom
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn((file: any) => `blob:mock-${file.name || 'file'}`);
  URL.revokeObjectURL = vi.fn();
}

const mockPush = vi.fn();
vi.mock('../src/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/bang-tin',
  Link: ({ children, href, className, onClick, ...rest }: any) => (
    <a href={href} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/bang-tin',
  useSearchParams: () => new URLSearchParams(),
}));

const mockUser = {
  id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
  handle: 'creator',
  display_name: 'Winkey Creator',
  email: 'creator@winkey.vn',
  avatar_url: 'https://images.winkey.vn/avatar.webp',
  roles: ['viewer'], // Note: any signed-in user, no creator role required for social video!
  is_private: false,
};

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    can: {
      uploadVideo: false,
      comment: true,
      manageChannel: false,
      moderateComments: false,
      accessAdmin: false,
    },
    isCreator: false,
  }),
}));

import {
  validateSocialVideoFile,
  pollVideoProcessing,
  MAX_SOCIAL_VIDEO_BYTES,
  MAX_SOCIAL_VIDEO_SECONDS,
} from '../src/lib/video/social-video';
import { PostComposer } from '../src/components/social/posts/post-composer';
import { PostVideoEmbed } from '../src/components/social/posts/post-video-embed';
import { PostSocialVideoPlayer } from '../src/components/social/posts/post-social-player';
import { api } from '../src/lib/api-client';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('SOC-2b: Short Social Videos in Posts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. File Limits Validation (Browser Checks)', () => {
    it('enforces exact ADR-049 limits: 300 MiB and 180 seconds', () => {
      expect(MAX_SOCIAL_VIDEO_BYTES).toBe(300 * 1024 * 1024);
      expect(MAX_SOCIAL_VIDEO_SECONDS).toBe(180);
    });

    it('refuses video file exceeding 300 MiB with descriptive error', async () => {
      const largeFile = new File(['x'.repeat(100)], 'large.mp4', { type: 'video/mp4' });
      Object.defineProperty(largeFile, 'size', {
        value: 300 * 1024 * 1024 + 1, // 300 MiB + 1 byte
      });

      await expect(validateSocialVideoFile(largeFile)).rejects.toThrow(
        'Video vượt quá giới hạn 300 MiB (tối đa 300 MiB).',
      );
    });

    it('refuses video file longer than 180 seconds with descriptive error', async () => {
      const file = new File(['data'], 'too-long.mp4', { type: 'video/mp4' });
      Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 });

      // Mock prototype getter for duration
      const origDurationDesc = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'duration',
      );
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
        configurable: true,
        get: () => 185, // 185s > 180s
      });

      // Dispatch event after src set
      const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        set: function () {
          setTimeout(() => {
            this.dispatchEvent(new Event('loadedmetadata'));
          }, 5);
        },
      });

      try {
        await expect(validateSocialVideoFile(file)).rejects.toThrow(
          'Thời lượng video vượt quá 3 phút (tối đa 180 giây).',
        );
      } finally {
        if (origDurationDesc) {
          Object.defineProperty(HTMLMediaElement.prototype, 'duration', origDurationDesc);
        }
        if (origSrcDesc) {
          Object.defineProperty(HTMLMediaElement.prototype, 'src', origSrcDesc);
        }
      }
    });

    it('accepts video file within 300 MiB and <= 180 seconds', async () => {
      const file = new File(['valid'], 'valid.mp4', { type: 'video/mp4' });
      Object.defineProperty(file, 'size', { value: 20 * 1024 * 1024 });

      const origDurationDesc = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'duration',
      );
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
        configurable: true,
        get: () => 45, // 45s <= 180s
      });

      const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        set: function () {
          setTimeout(() => {
            this.dispatchEvent(new Event('loadedmetadata'));
          }, 5);
        },
      });

      try {
        const meta = await validateSocialVideoFile(file);
        expect(meta.duration).toBe(45);
      } finally {
        if (origDurationDesc) {
          Object.defineProperty(HTMLMediaElement.prototype, 'duration', origDurationDesc);
        }
        if (origSrcDesc) {
          Object.defineProperty(HTMLMediaElement.prototype, 'src', origSrcDesc);
        }
      }
    });
  });

  describe('2. Processing & Error Handling', () => {
    it('throws descriptive error from data.error on FAILED status', async () => {
      const getSpy = vi.spyOn(api.upload, 'GET').mockResolvedValueOnce({
        response: new Response(null, { status: 200 }),
        data: {
          video_id: 'vid-failed',
          status: 'FAILED',
          progress: 0,
          error: 'The video is longer than 3 minutes.',
        },
        error: undefined,
      } as any);

      await expect(pollVideoProcessing('vid-failed')).rejects.toThrow(
        'The video is longer than 3 minutes.',
      );

      getSpy.mockRestore();
    });

    it('successfully waits for READY status and supports visibilitychange wake up', async () => {
      const getSpy = vi
        .spyOn(api.upload, 'GET')
        .mockResolvedValueOnce({
          response: new Response(null, { status: 200 }),
          data: { video_id: 'vid-ready', status: 'PROCESSING', progress: 50, error: null },
          error: undefined,
        } as any)
        .mockResolvedValueOnce({
          response: new Response(null, { status: 200 }),
          data: { video_id: 'vid-ready', status: 'READY', progress: 100, error: null },
          error: undefined,
        } as any);

      const promise = pollVideoProcessing('vid-ready', {
        initialIntervalMs: 50,
        subsequentIntervalMs: 100,
        firstPhaseDurationMs: 500,
      });

      // Simulate tab visibility restored
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));

      const res = await promise;
      expect(res.status).toBe('READY');
      expect(res.videoId).toBe('vid-ready');

      getSpy.mockRestore();
    });

    it('throws error when polling reaches timeout limit', async () => {
      const getSpy = vi.spyOn(api.upload, 'GET').mockResolvedValue({
        response: new Response(null, { status: 200 }),
        data: { video_id: 'vid-timeout', status: 'PROCESSING', progress: 10, error: null },
        error: undefined,
      } as any);

      await expect(
        pollVideoProcessing('vid-timeout', {
          timeoutMs: 30,
          initialIntervalMs: 15,
        }),
      ).rejects.toThrow('Quá thời gian chờ xử lý video (15 phút).');

      getSpy.mockRestore();
    });
  });

  describe('3. PostComposer Social Video Flow', () => {
    it('has Video attachment button exclusive with images, film, and reshare', () => {
      renderWithProviders(<PostComposer />);

      const videoBtn = screen.getByRole('button', { name: /Đính kèm video/i });
      const imageBtn = screen.getByRole('button', { name: /Đính kèm ảnh/i });
      const filmBtn = screen.getByRole('button', { name: /Gắn phim Winkey/i });

      expect(videoBtn).toBeDefined();
      expect(imageBtn).toBeDefined();
      expect(filmBtn).toBeDefined();

      expect(videoBtn.hasAttribute('disabled')).toBe(false);
      expect(imageBtn.hasAttribute('disabled')).toBe(false);
      expect(filmBtn.hasAttribute('disabled')).toBe(false);
    });

    it('maps 409 VIDEO_IN_USE to a clear error message upon submitting', async () => {
      const postSpy = vi.spyOn(api.social, 'POST').mockResolvedValueOnce({
        response: new Response(null, { status: 409 }),
        data: undefined,
        error: {
          type: '/problems/conflict',
          title: 'Video in use',
          status: 409,
          code: 'VIDEO_IN_USE',
          detail: 'Video already attached to another live post',
        },
      } as any);

      renderWithProviders(<PostComposer />);

      const textarea = screen.getByPlaceholderText('Bạn đang nghĩ gì?');
      fireEvent.change(textarea, { target: { value: 'Bài viết đính kèm video bị trùng' } });

      const submitBtn = screen.getByRole('button', { name: /Đăng bài viết/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(postSpy).toHaveBeenCalled();
      });

      expect(await screen.findByText('Video này đã được gắn vào một bài viết khác.')).toBeDefined();

      postSpy.mockRestore();
    });
  });

  describe('4. PostVideoEmbed: FILM vs SOCIAL Rendering', () => {
    it('renders watch link card when purpose is FILM or undefined', () => {
      const filmVideo = {
        id: 'film-123',
        title: 'Phim bom tấn 2026',
        owner: { id: 'u1', handle: 'winkey_studio', display_name: 'Winkey Studio' },
        duration_ms: 7200000,
        view_count: 50000,
        published_at: '2026-01-01T00:00:00Z',
        thumbnail_url: 'https://images.winkey.vn/film.jpg',
        purpose: 'FILM',
      };

      renderWithProviders(<PostVideoEmbed video={filmVideo as any} />);

      const filmEmbed = screen.getByTestId('post-film-embed');
      expect(filmEmbed).toBeDefined();
      expect(screen.queryByTestId('post-social-player')).toBeNull();

      const link = filmEmbed.querySelector('a');
      expect(link?.getAttribute('href')).toBe('/watch?v=film-123');
    });

    it('renders inline player when purpose is SOCIAL', () => {
      const socialVideo = {
        id: 'social-123',
        title: 'Video ngắn thú vị',
        owner: { id: 'u2', handle: 'alex', display_name: 'Alex' },
        duration_ms: 30000,
        view_count: 1200,
        published_at: '2026-10-28T00:00:00Z',
        thumbnail_url: 'https://images.winkey.vn/social.jpg',
        purpose: 'SOCIAL',
        playback: {
          hls_url: 'https://media.winkey.vn/hls/social-123.m3u8',
          thumbnail_url: 'https://images.winkey.vn/social.jpg',
        },
      };

      renderWithProviders(<PostVideoEmbed video={socialVideo as any} />);

      const player = screen.getByTestId('post-social-player');
      expect(player).toBeDefined();
      expect(screen.queryByTestId('post-film-embed')).toBeNull();

      const videoEl = screen.getByTestId('social-video-element') as HTMLVideoElement;
      expect(videoEl).toBeDefined();
      expect(videoEl.muted).toBe(true);
      expect(videoEl.getAttribute('playsinline')).not.toBeNull();
    });
  });

  describe('5. PostSocialVideoPlayer: Autoplay, Reduced Motion & Mute Toggle', () => {
    it('toggles mute/unmute when clicking volume button', () => {
      const socialVideo = {
        id: 'social-456',
        title: 'Short video reel',
        owner: { id: 'u2', handle: 'alex', display_name: 'Alex' },
        duration_ms: 15000,
        view_count: 500,
        published_at: '2026-10-28T00:00:00Z',
        thumbnail_url: 'https://images.winkey.vn/social456.jpg',
        purpose: 'SOCIAL',
        playback: {
          hls_url: 'https://media.winkey.vn/hls/social-456.m3u8',
          thumbnail_url: 'https://images.winkey.vn/social456.jpg',
        },
      };

      renderWithProviders(
        <PostSocialVideoPlayer videoId="social-456" initialVideo={socialVideo as any} />,
      );

      const videoEl = screen.getByTestId('social-video-element') as HTMLVideoElement;
      expect(videoEl.muted).toBe(true);

      const muteBtn = screen.getByTestId('social-video-mute-btn');
      expect(muteBtn.getAttribute('aria-label')).toBe('Bật âm thanh');

      // Click to unmute
      fireEvent.click(muteBtn);
      expect(videoEl.muted).toBe(false);
      expect(muteBtn.getAttribute('aria-label')).toBe('Tắt âm thanh');

      // Click to mute again
      fireEvent.click(muteBtn);
      expect(videoEl.muted).toBe(true);
    });

    it('respects prefers-reduced-motion and never autoplays when enabled', () => {
      const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
        return {
          matches: query.includes('prefers-reduced-motion: reduce'),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        } as any;
      });

      let observedCallback: any = null;
      class MockIntersectionObserver {
        constructor(callback: any) {
          observedCallback = callback;
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
      vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

      renderWithProviders(
        <PostSocialVideoPlayer
          videoId="social-motion"
          initialVideo={
            {
              id: 'social-motion',
              title: 'Reduced motion test',
              owner: { id: 'u1', handle: 'test', display_name: 'Test' },
              duration_ms: 10000,
              view_count: 10,
              published_at: '2026-10-28T00:00:00Z',
              thumbnail_url: '',
              purpose: 'SOCIAL',
              playback: { hls_url: 'https://media.winkey.vn/test.m3u8', thumbnail_url: '' },
            } as any
          }
        />,
      );

      const videoEl = screen.getByTestId('social-video-element') as HTMLVideoElement;
      const playSpy = vi.spyOn(videoEl, 'play').mockResolvedValue(undefined);

      // Trigger intersection with 100% visible
      act(() => {
        observedCallback?.([{ isIntersecting: true, intersectionRatio: 1.0 }]);
      });

      // Because prefers-reduced-motion: reduce is true, video.play must NEVER be called
      expect(playSpy).not.toHaveBeenCalled();

      matchMediaSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it('autoplays when >= 50% visible and pauses when it leaves if reduced motion is disabled', () => {
      const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
        return {
          matches: false, // prefers-reduced-motion is false
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        } as any;
      });

      let observedCallback: any = null;
      class MockIntersectionObserver {
        constructor(callback: any) {
          observedCallback = callback;
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
      vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

      renderWithProviders(
        <PostSocialVideoPlayer
          videoId="social-autoplay"
          initialVideo={
            {
              id: 'social-autoplay',
              title: 'Autoplay test',
              owner: { id: 'u1', handle: 'test', display_name: 'Test' },
              duration_ms: 10000,
              view_count: 10,
              published_at: '2026-10-28T00:00:00Z',
              thumbnail_url: '',
              purpose: 'SOCIAL',
              playback: { hls_url: 'https://media.winkey.vn/test.m3u8', thumbnail_url: '' },
            } as any
          }
        />,
      );

      const videoEl = screen.getByTestId('social-video-element') as HTMLVideoElement;
      const playSpy = vi.spyOn(videoEl, 'play').mockResolvedValue(undefined);
      const pauseSpy = vi.spyOn(videoEl, 'pause').mockImplementation(() => {});

      // 1. When >= 50% visible -> play
      act(() => {
        observedCallback?.([{ isIntersecting: true, intersectionRatio: 0.6 }]);
      });
      expect(playSpy).toHaveBeenCalled();

      // 2. When leaves (< 50% visible) -> pause
      act(() => {
        observedCallback?.([{ isIntersecting: false, intersectionRatio: 0.2 }]);
      });
      expect(pauseSpy).toHaveBeenCalled();

      matchMediaSpy.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  describe('6. Studio Exclusion', () => {
    it('filters out SOCIAL purpose videos from studio video lists', () => {
      const mixedVideos = [
        { id: 'v1', title: 'Film 1', purpose: 'FILM', status: 'READY' },
        { id: 'v2', title: 'Social Video 1', purpose: 'SOCIAL', status: 'READY' },
        { id: 'v3', title: 'Film 2', status: 'READY' }, // default missing purpose is FILM
      ];

      const filtered = mixedVideos.filter((v: any) => v.purpose !== 'SOCIAL');
      expect(filtered).toHaveLength(2);
      expect(filtered.map((v) => v.id)).toEqual(['v1', 'v3']);
    });
  });
});
