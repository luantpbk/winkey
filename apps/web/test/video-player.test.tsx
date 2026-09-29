import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { VideoPlayer } from '../src/components/video/video-player';

// Mock Hls.js
vi.mock('hls.js', () => {
  const isSupportedMock = vi.fn().mockReturnValue(true);
  const HlsMock = vi.fn().mockImplementation(() => {
    return {
      loadSource: vi.fn(),
      attachMedia: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
      currentLevel: -1,
      levels: [
        { height: 1080, bitrate: 5000000, name: '1080p' },
        { height: 720, bitrate: 2800000, name: '720p' },
      ],
    };
  });
  // attach static isSupported
  (HlsMock as any).isSupported = isSupportedMock;
  (HlsMock as any).Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    ERROR: 'hlsError',
  };
  (HlsMock as any).ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
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
  });
});
