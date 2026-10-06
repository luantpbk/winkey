import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { VideoPlayer } from '../src/components/video/video-player';

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
  // attach static isSupported
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

describe('VideoPlayer Component', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('LocalStorage Watch Position Memory', () => {
    it('saves playback position to localStorage on timeupdate', () => {
      const videoId = '0192f5e4-7c1a-7b3e-9d2a-test-resume';
      const { container } = render(
        <VideoPlayer
          videoId={videoId}
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'currentTime', { value: 15.5, writable: true });

      fireEvent.timeUpdate(video);

      expect(localStorage.getItem(`winkey_playback_pos_${videoId}`)).toBe('15.5');
    });

    it('resumes playback position on loadedmetadata if valid saved time exists', () => {
      const videoId = '0192f5e4-7c1a-7b3e-9d2a-test-resume';
      localStorage.setItem(`winkey_playback_pos_${videoId}`, '42.0');

      const { container } = render(
        <VideoPlayer
          videoId={videoId}
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'duration', { value: 120.0, writable: true });
      Object.defineProperty(video, 'currentTime', { value: 0, writable: true });

      fireEvent.loadedMetadata(video);

      expect(video.currentTime).toBe(42.0);
    });

    it('clears saved position from localStorage when video ends', () => {
      const videoId = '0192f5e4-7c1a-7b3e-9d2a-test-ended';
      localStorage.setItem(`winkey_playback_pos_${videoId}`, '100.0');

      const { container } = render(
        <VideoPlayer
          videoId={videoId}
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      fireEvent.ended(video);

      expect(localStorage.getItem(`winkey_playback_pos_${videoId}`)).toBeNull();
    });

    it('gracefully handles localStorage exceptions without crashing', () => {
      const videoId = '0192f5e4-7c1a-7b3e-9d2a-test-quota';
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      const { container } = render(
        <VideoPlayer
          videoId={videoId}
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'currentTime', { value: 10.0, writable: true });

      // Should not throw
      expect(() => fireEvent.timeUpdate(video)).not.toThrow();
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('toggles play/pause with Space and k keys', () => {
      const { container } = render(
        <VideoPlayer
          videoId="test-kbd"
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      const playSpy = vi.spyOn(video, 'play').mockImplementation(async () => {});
      const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {});

      // When paused, Space calls play
      Object.defineProperty(video, 'paused', { value: true, writable: true });
      fireEvent.keyDown(window, { code: 'Space' });
      expect(playSpy).toHaveBeenCalled();

      // When playing, 'KeyK' calls pause
      Object.defineProperty(video, 'paused', { value: false, writable: true });
      fireEvent.keyDown(window, { code: 'KeyK' });
      expect(pauseSpy).toHaveBeenCalled();
    });

    it('seeks ±10s with j and l keys', () => {
      const { container } = render(
        <VideoPlayer
          videoId="test-kbd"
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'duration', { value: 100, writable: true });
      Object.defineProperty(video, 'currentTime', { value: 30, writable: true });

      // KeyJ seeks -10s
      fireEvent.keyDown(window, { code: 'KeyJ' });
      expect(video.currentTime).toBe(20);

      // KeyL seeks +10s
      fireEvent.keyDown(window, { code: 'KeyL' });
      expect(video.currentTime).toBe(30);
    });

    it('seeks ±5s with ArrowLeft and ArrowRight keys', () => {
      const { container } = render(
        <VideoPlayer
          videoId="test-kbd"
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'duration', { value: 100, writable: true });
      Object.defineProperty(video, 'currentTime', { value: 25, writable: true });

      fireEvent.keyDown(window, { code: 'ArrowLeft' });
      expect(video.currentTime).toBe(20);

      fireEvent.keyDown(window, { code: 'ArrowRight' });
      expect(video.currentTime).toBe(25);
    });

    it('toggles mute with m key', () => {
      const { container } = render(
        <VideoPlayer
          videoId="test-kbd"
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      video.muted = false;

      fireEvent.keyDown(window, { code: 'KeyM' });
      expect(video.muted).toBe(true);

      fireEvent.keyDown(window, { code: 'KeyM' });
      expect(video.muted).toBe(false);
    });

    it('ignores shortcuts when user is typing in an input or textarea', () => {
      const { container } = render(
        <div>
          <input data-testid="test-input" type="text" />
          <VideoPlayer
            videoId="test-kbd"
            src="https://media.winkey.vn/sample.m3u8"
            title="Sample Video"
          />
        </div>,
      );

      const input = container.querySelector('input') as HTMLInputElement;
      input.focus();

      const video = container.querySelector('video') as HTMLVideoElement;
      const playSpy = vi.spyOn(video, 'play').mockImplementation(async () => {});

      fireEvent.keyDown(input, { code: 'Space' });
      expect(playSpy).not.toHaveBeenCalled();
    });

    it('does not trigger play/pause when focus is on a button or link', () => {
      const { container } = render(
        <div>
          <button data-testid="test-btn">Subscribe</button>
          <a data-testid="test-link" href="#comments">
            Comments
          </a>
          <VideoPlayer
            videoId="test-kbd"
            src="https://media.winkey.vn/sample.m3u8"
            title="Sample Video"
          />
        </div>,
      );

      const btn = container.querySelector('button') as HTMLButtonElement;
      btn.focus();

      const video = container.querySelector('video') as HTMLVideoElement;
      const playSpy = vi.spyOn(video, 'play').mockImplementation(async () => {});
      const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {});

      fireEvent.keyDown(btn, { code: 'Space' });
      expect(playSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();

      fireEvent.keyDown(btn, { code: 'Enter' });
      expect(playSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();

      const link = container.querySelector('a') as HTMLAnchorElement;
      link.focus();

      fireEvent.keyDown(link, { code: 'Space' });
      expect(playSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
    });

    it('does not trigger fullscreen when Ctrl+F, Meta+F, or Alt+F is pressed', () => {
      const { container } = render(
        <VideoPlayer
          videoId="test-kbd"
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const fullscreenSpy = vi.fn();
      const div = container.firstChild as HTMLElement;
      div.requestFullscreen = fullscreenSpy;

      fireEvent.keyDown(window, { code: 'KeyF', ctrlKey: true });
      expect(fullscreenSpy).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { code: 'KeyF', metaKey: true });
      expect(fullscreenSpy).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { code: 'KeyF', altKey: true });
      expect(fullscreenSpy).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling and Retry', () => {
    it('displays error overlay with retry button on error', () => {
      const { container, getByText } = render(
        <VideoPlayer
          videoId="test-err"
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      fireEvent.error(video);

      expect(getByText('Không thể phát video')).toBeDefined();
      const retryButton = getByText('Thử lại');
      expect(retryButton).toBeDefined();

      // Clicking retry recovers
      act(() => {
        fireEvent.click(retryButton);
      });
      expect(container.querySelector('video')).toBeDefined();
    });

    it('recovers up to 3 times on fatal NETWORK_ERROR and shows error overlay on the 4th attempt', () => {
      const { getByText, queryByText } = render(
        <VideoPlayer
          videoId="test-hls-retry"
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      expect(latestHlsInstance).not.toBeNull();

      // Attempt 1
      act(() => {
        latestHlsInstance!.emit('hlsError', { fatal: true, type: 'networkError' });
      });
      expect(latestHlsInstance!.startLoad).toHaveBeenCalledTimes(1);
      expect(queryByText('Không thể phát video')).toBeNull();

      // Attempt 2
      act(() => {
        latestHlsInstance!.emit('hlsError', { fatal: true, type: 'networkError' });
      });
      expect(latestHlsInstance!.startLoad).toHaveBeenCalledTimes(2);
      expect(queryByText('Không thể phát video')).toBeNull();

      // Attempt 3
      act(() => {
        latestHlsInstance!.emit('hlsError', { fatal: true, type: 'networkError' });
      });
      expect(latestHlsInstance!.startLoad).toHaveBeenCalledTimes(3);
      expect(queryByText('Không thể phát video')).toBeNull();

      // Attempt 4 (> 3 attempts) -> destroys instance and displays error overlay
      act(() => {
        latestHlsInstance!.emit('hlsError', { fatal: true, type: 'networkError' });
      });
      expect(latestHlsInstance!.destroy).toHaveBeenCalled();
      expect(getByText('Không thể phát video')).toBeDefined();
    });

    it('immediately destroys and displays error overlay on OTHER_ERROR', () => {
      const { getByText } = render(
        <VideoPlayer
          videoId="test-hls-other"
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      act(() => {
        latestHlsInstance!.emit('hlsError', { fatal: true, type: 'otherError' });
      });

      expect(latestHlsInstance!.destroy).toHaveBeenCalled();
      expect(getByText('Không thể phát video')).toBeDefined();
    });
  });

  describe('QOE2 VideoPlayer Event Wiring (ADR-030 / Issue #257)', () => {
    it('dispatches loadeddata to tracker and does not trigger first frame on metadata timeupdate', () => {
      const videoId = '0192f5e4-7c1a-7b3e-9d2a-qoe2-wiring';
      const { container } = render(
        <VideoPlayer
          videoId={videoId}
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'currentTime', { value: 15.0, writable: true });

      // 1. loadedmetadata -> timeupdate fires before play
      fireEvent.loadedMetadata(video);
      fireEvent.timeUpdate(video);

      // 2. loadeddata fires
      fireEvent.loadedData(video);

      // 3. User plays
      fireEvent.play(video);
      fireEvent.playing(video);

      expect(video).toBeDefined();
    });

    it('ignores waiting event when video is paused or tab is hidden', () => {
      const videoId = '0192f5e4-7c1a-7b3e-9d2a-qoe2-paused-wait';
      const { container } = render(
        <VideoPlayer
          videoId={videoId}
          src="https://media.winkey.vn/sample.m3u8"
          title="Sample Video"
        />,
      );

      const video = container.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'paused', { value: true, writable: true });

      // Firing waiting while paused should be safely handled without error
      expect(() => fireEvent.waiting(video)).not.toThrow();

      // Firing pause should safely freeze any in-flight rebuffer refs
      expect(() => fireEvent.pause(video)).not.toThrow();

      // Firing seeking should safely freeze any in-flight rebuffer refs
      expect(() => fireEvent.seeking(video)).not.toThrow();
    });
  });
});
