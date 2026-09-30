import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import type { SubtitleTrack } from '@winkey/api-client';
import { VideoPlayer } from '../src/components/video/video-player';
import { api } from '../src/lib/api-client';

type HlsHandler = (event: string, data: unknown) => void;

interface MockHls {
  handlers: Record<string, HlsHandler[]>;
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  on: (event: string, cb: HlsHandler) => void;
  emit: (event: string, data: unknown) => void;
  destroy: ReturnType<typeof vi.fn>;
  startLoad: ReturnType<typeof vi.fn>;
  recoverMediaError: ReturnType<typeof vi.fn>;
  currentLevel: number;
  levels: Array<{ height: number; bitrate: number; name: string }>;
}

let latestHlsInstance: MockHls | null = null;

// Mock Hls.js
vi.mock('hls.js', () => {
  const isSupportedMock = vi.fn().mockReturnValue(true);
  const HlsMock = vi.fn().mockImplementation(() => {
    const handlers: Record<string, HlsHandler[]> = {};
    const instance: MockHls = {
      handlers,
      loadSource: vi.fn(),
      attachMedia: vi.fn(),
      on: vi.fn((event: string, cb: HlsHandler) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
      }),
      emit: (event: string, data: unknown) => {
        (handlers[event] || []).forEach((cb) => cb(event, data));
      },
      destroy: vi.fn(),
      startLoad: vi.fn(),
      recoverMediaError: vi.fn(),
      currentLevel: -1,
      levels: [
        { height: 1080, bitrate: 5000000, name: '1080p' },
        { height: 720, bitrate: 2800000, name: '720p' },
      ],
    };
    latestHlsInstance = instance;
    return instance;
  });
  (HlsMock as unknown as Record<string, unknown>).isSupported = isSupportedMock;
  (HlsMock as unknown as Record<string, unknown>).Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    ERROR: 'hlsError',
  };
  (HlsMock as unknown as Record<string, unknown>).ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
    OTHER_ERROR: 'otherError',
  };
  return { default: HlsMock };
});

describe('Player Subtitles, Storyboard Previews & Signed-URL Refresh (Task U7)', () => {
  const mockSubtitles: SubtitleTrack[] = [
    {
      lang: 'vi',
      label: 'Tiếng Việt',
      source: 'UPLOAD',
      url: 'https://media.winkey.vn/v/vid-1/subtitles/vi.vtt',
      updated_at: '2026-09-20T10:00:00Z',
    },
    {
      lang: 'en',
      label: 'English',
      source: 'UPLOAD',
      url: 'https://media.winkey.vn/v/vid-1/subtitles/en.vtt',
      updated_at: '2026-09-20T10:00:00Z',
    },
  ];

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  describe('1. Subtitle Tracks and CC Menu (ADR-018)', () => {
    it('renders native <track> elements with crossOrigin="anonymous" on <video>', () => {
      const { container } = render(
        <VideoPlayer
          videoId="vid-sub-1"
          src="https://media.winkey.vn/master.m3u8"
          subtitles={mockSubtitles}
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).toBeDefined();
      expect(video.getAttribute('crossOrigin')).toBe('anonymous');

      const tracks = container.querySelectorAll('track');
      expect(tracks).toHaveLength(2);
      expect(tracks[0].getAttribute('srcLang')).toBe('vi');
      expect(tracks[0].getAttribute('label')).toBe('Tiếng Việt');
      expect(tracks[0].getAttribute('src')).toBe(
        'https://media.winkey.vn/v/vid-1/subtitles/vi.vtt',
      );
      expect(tracks[1].getAttribute('srcLang')).toBe('en');
    });

    it('renders CC menu button and toggles dropdown with "Tắt" and available tracks', () => {
      const { getByTestId, queryByTestId, getByText } = render(
        <VideoPlayer
          videoId="vid-sub-1"
          src="https://media.winkey.vn/master.m3u8"
          subtitles={mockSubtitles}
        />,
      );

      const ccBtn = getByTestId('cc-menu-button');
      expect(ccBtn).toBeDefined();

      // Dropdown initially closed
      expect(queryByTestId('cc-menu-dropdown')).toBeNull();

      // Open dropdown
      fireEvent.click(ccBtn);
      expect(getByTestId('cc-menu-dropdown')).toBeDefined();
      expect(getByText('Tắt')).toBeDefined();
      expect(getByText('Tiếng Việt')).toBeDefined();
      expect(getByText('English')).toBeDefined();
    });

    it('persists selected subtitle language to localStorage and applies textTrack mode', () => {
      const { container, getByTestId } = render(
        <VideoPlayer
          videoId="vid-sub-1"
          src="https://media.winkey.vn/master.m3u8"
          subtitles={mockSubtitles}
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      // Mock textTracks on video
      const mockTextTracks = [
        { language: 'vi', label: 'Tiếng Việt', mode: 'disabled' },
        { language: 'en', label: 'English', mode: 'disabled' },
      ];
      Object.defineProperty(video, 'textTracks', { value: mockTextTracks, writable: true });

      // Open CC menu and select 'Tiếng Việt'
      fireEvent.click(getByTestId('cc-menu-button'));
      fireEvent.click(getByTestId('cc-option-vi'));

      expect(localStorage.getItem('winkey.subtitle_lang')).toBe('vi');
      expect(mockTextTracks[0].mode).toBe('showing');
      expect(mockTextTracks[1].mode).toBe('disabled');

      // Select 'Tắt'
      fireEvent.click(getByTestId('cc-menu-button'));
      fireEvent.click(getByTestId('cc-option-off'));

      expect(localStorage.getItem('winkey.subtitle_lang')).toBe('off');
      expect(mockTextTracks[0].mode).toBe('disabled');
      expect(mockTextTracks[1].mode).toBe('disabled');
    });

    it('pre-selects saved subtitle language preference from localStorage on mount', () => {
      localStorage.setItem('winkey.subtitle_lang', 'en');

      const { container } = render(
        <VideoPlayer
          videoId="vid-sub-1"
          src="https://media.winkey.vn/master.m3u8"
          subtitles={mockSubtitles}
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      const mockTextTracks = [
        { language: 'vi', label: 'Tiếng Việt', mode: 'disabled' },
        { language: 'en', label: 'English', mode: 'disabled' },
      ];
      Object.defineProperty(video, 'textTracks', { value: mockTextTracks, writable: true });

      fireEvent.loadedMetadata(video);

      expect(mockTextTracks[1].mode).toBe('showing');
      expect(mockTextTracks[0].mode).toBe('disabled');
    });

    it('toggles captions on and off with "c" key shortcut', () => {
      const { container } = render(
        <VideoPlayer
          videoId="vid-sub-1"
          src="https://media.winkey.vn/master.m3u8"
          subtitles={mockSubtitles}
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      const mockTextTracks = [
        { language: 'vi', label: 'Tiếng Việt', mode: 'disabled' },
        { language: 'en', label: 'English', mode: 'disabled' },
      ];
      Object.defineProperty(video, 'textTracks', { value: mockTextTracks, writable: true });

      // Press 'c' to turn on (defaults to first track 'vi')
      fireEvent.keyDown(window, { code: 'KeyC' });
      expect(localStorage.getItem('winkey.subtitle_lang')).toBe('vi');
      expect(mockTextTracks[0].mode).toBe('showing');

      // Press 'c' again to turn off
      fireEvent.keyDown(window, { code: 'KeyC' });
      expect(localStorage.getItem('winkey.subtitle_lang')).toBe('off');
      expect(mockTextTracks[0].mode).toBe('disabled');
    });

    it('contains no dangerouslySetInnerHTML or innerHTML for cues', () => {
      const { container } = render(
        <VideoPlayer
          videoId="vid-sub-1"
          src="https://media.winkey.vn/master.m3u8"
          subtitles={mockSubtitles}
        />,
      );

      // Verify that no element has custom cue containers
      expect(container.querySelector('.vtt-cue')).toBeNull();
      expect(container.querySelector('[data-cue]')).toBeNull();
    });
  });

  describe('2. Storyboard Scrub Previews (ADR-017 / V5a)', () => {
    it('lazy-fetches storyboard .vtt on seek bar hover and displays thumbnail preview', async () => {
      const mockVtt = `WEBVTT

00:00:00.000 --> 00:00:10.000
sprites_0.jpg#xywh=0,0,160,90

00:00:10.000 --> 00:00:20.000
sprites_0.jpg#xywh=160,0,160,90
`;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => mockVtt,
      } as Response);

      const storyboardUrl = 'https://media.winkey.vn/storyboard.vtt';
      const { getByTestId, queryByTestId } = render(
        <VideoPlayer
          videoId="vid-sb-1"
          durationMs={60000}
          src="https://media.winkey.vn/master.m3u8"
          storyboardUrl={storyboardUrl}
        />,
      );

      const seekBar = getByTestId('seek-bar');
      // Mock getBoundingClientRect
      vi.spyOn(seekBar, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        right: 600,
        bottom: 20,
        width: 600,
        height: 20,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      // No request before hover
      expect(fetchSpy).not.toHaveBeenCalled();

      // Pointer enter on seek bar triggers lazy fetch
      await act(async () => {
        fireEvent.pointerEnter(seekBar, { clientX: 100 });
      });

      expect(fetchSpy).toHaveBeenCalledWith(storyboardUrl);

      // Verify thumbnail preview is displayed
      const thumbnail = queryByTestId('storyboard-thumbnail');
      expect(thumbnail).toBeDefined();
    });

    it('falls back to plain time tooltip when no storyboardUrl is provided', () => {
      const { getByTestId, queryByTestId } = render(
        <VideoPlayer
          videoId="vid-sb-none"
          durationMs={60000}
          src="https://media.winkey.vn/master.m3u8"
          storyboardUrl={null}
        />,
      );

      const seekBar = getByTestId('seek-bar');
      vi.spyOn(seekBar, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        right: 600,
        bottom: 20,
        width: 600,
        height: 20,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      act(() => {
        fireEvent.pointerEnter(seekBar, { clientX: 150 });
      });

      // Shows plain time tooltip, no storyboard thumbnail
      expect(getByTestId('time-tooltip')).toBeDefined();
      expect(queryByTestId('storyboard-thumbnail')).toBeNull();
    });
  });

  describe('3. Signed-URL Auto-Refresh (ADR-017 / SEC1)', () => {
    it('schedules a timer ~5 min before expires_at and refreshes media URLs preserving currentTime', async () => {
      vi.useFakeTimers();

      // expires_at is 6 minutes from now
      const now = Date.now();
      const expiresAt = new Date(now + 6 * 60 * 1000).toISOString();

      const newPlayback = {
        hls_url: 'https://media.winkey.vn/s/new_sig/master.m3u8',
        thumbnail_url: 'https://media.winkey.vn/s/new_sig/thumb.jpg',
        storyboard_url: 'https://media.winkey.vn/s/new_sig/storyboard.vtt',
        expires_at: new Date(now + 12 * 60 * 1000).toISOString(),
        subtitles: [
          {
            lang: 'vi',
            label: 'Tiếng Việt',
            source: 'UPLOAD' as const,
            url: 'https://media.winkey.vn/s/new_sig/vi.vtt',
            updated_at: '2026-09-20T10:00:00Z',
          },
        ],
        renditions: [],
      };

      const apiGetSpy = vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
        data: {
          id: 'vid-signed-1',
          title: 'Signed Video',
          playback: newPlayback,
        },
        response: new Response(null, { status: 200 }),
      } as any);

      const { container } = render(
        <VideoPlayer
          videoId="vid-signed-1"
          src="https://media.winkey.vn/s/old_sig/master.m3u8"
          expiresAt={expiresAt}
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'currentTime', { value: 45.0, writable: true });
      Object.defineProperty(video, 'paused', { value: false, writable: true });
      const playSpy = vi.spyOn(video, 'play').mockImplementation(async () => {});

      expect(latestHlsInstance).not.toBeNull();
      expect(apiGetSpy).not.toHaveBeenCalled();

      // Advance by 1 minute (now 5 minutes before expires_at)
      await act(async () => {
        vi.advanceTimersByTime(60 * 1000 + 100);
      });

      // API was called to refresh signed playback
      expect(apiGetSpy).toHaveBeenCalledWith('/v1/videos/{video_id}', {
        params: { path: { video_id: 'vid-signed-1' } },
      });

      // New HLS source loaded, currentTime and play state restored
      expect(latestHlsInstance!.loadSource).toHaveBeenCalledWith(
        'https://media.winkey.vn/s/new_sig/master.m3u8',
      );
      expect(video.currentTime).toBe(45.0);
      expect(playSpy).toHaveBeenCalled();
    });

    it('clears refresh timer on unmount and does not call API', async () => {
      vi.useFakeTimers();

      const expiresAt = new Date(Date.now() + 6 * 60 * 1000).toISOString();
      const apiGetSpy = vi.spyOn(api.video, 'GET');

      const { unmount } = render(
        <VideoPlayer
          videoId="vid-signed-1"
          src="https://media.winkey.vn/s/old_sig/master.m3u8"
          expiresAt={expiresAt}
        />,
      );

      // Unmount component
      unmount();

      // Advance timer past the scheduled refresh point
      await act(async () => {
        vi.advanceTimersByTime(2 * 60 * 1000);
      });

      // Timer was cleanly cancelled on unmount
      expect(apiGetSpy).not.toHaveBeenCalled();
    });

    it('refreshes signed URLs on 403 or 410 media error once', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const newPlayback = {
        hls_url: 'https://media.winkey.vn/s/recovered/master.m3u8',
        thumbnail_url: 'https://media.winkey.vn/s/recovered/thumb.jpg',
        expires_at: new Date(Date.now() + 120 * 60 * 1000).toISOString(),
        renditions: [],
      };

      const apiGetSpy = vi.spyOn(api.video, 'GET').mockResolvedValueOnce({
        data: {
          id: 'vid-signed-err',
          title: 'Signed Video',
          playback: newPlayback,
        },
        response: new Response(null, { status: 200 }),
      } as any);

      render(
        <VideoPlayer
          videoId="vid-signed-err"
          src="https://media.winkey.vn/s/old_sig/master.m3u8"
          expiresAt={expiresAt}
        />,
      );

      expect(latestHlsInstance).not.toBeNull();

      // Emit 403 error from HLS
      await act(async () => {
        latestHlsInstance!.emit('hlsError', {
          fatal: false,
          response: { code: 403 },
        });
      });

      expect(apiGetSpy).toHaveBeenCalledTimes(1);
    });
  });
});
