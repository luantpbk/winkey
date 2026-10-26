import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { VideoPlayer } from '../src/components/video/video-player';

// Mock hls.js
vi.mock('hls.js', () => {
  const isSupportedMock = vi.fn().mockReturnValue(true);
  const HlsMock = vi.fn().mockImplementation(() => {
    const handlers: Record<string, ((event: string, data: unknown) => void)[]> = {};
    return {
      handlers,
      loadSource: vi.fn(),
      attachMedia: vi.fn(),
      on: vi.fn((event: string, cb: (event: string, data: unknown) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
      }),
      emit: (event: string, data: unknown) => {
        (handlers[event] || []).forEach((cb) => cb(event, data));
      },
      destroy: vi.fn(),
      currentLevel: -1,
      levels: [{ height: 1080, bitrate: 5000000, name: '1080p' }],
      audioTracks: [],
    };
  });
  (HlsMock as unknown as Record<string, unknown>).isSupported = isSupportedMock;
  (HlsMock as unknown as Record<string, unknown>).Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    ERROR: 'hlsError',
    AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
    AUDIO_TRACK_SWITCHED: 'hlsAudioTrackSwitched',
  };
  (HlsMock as unknown as Record<string, unknown>).ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
  };
  return { default: HlsMock };
});

// Mock useViewCounter
vi.mock('../src/components/video/use-view-counter', () => ({
  useViewCounter: () => ({
    onPlay: vi.fn(),
    onTimeUpdate: vi.fn(),
    onSeeking: vi.fn(),
    onSeeked: vi.fn(),
    onEnded: vi.fn(),
    playbackIdRef: { current: 'mock-playback-id' },
  }),
}));

describe('VideoPlayer Mobile & Fullscreen Toolbar Auto-hide (Fake Timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('1. Hides toolbar after exactly 3 seconds when video is playing', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-auto-hide" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    const controls = getByTestId('player-controls');

    // Simulate play start
    act(() => {
      fireEvent.play(video);
    });

    expect(controls.className).toContain('opacity-100');

    // After 2.9 seconds, controls must still be visible
    act(() => {
      vi.advanceTimersByTime(2900);
    });
    expect(controls.className).toContain('opacity-100');
    expect(controls.className).not.toContain('opacity-0');

    // After reaching 3 seconds, controls must hide
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(controls.className).toContain('opacity-0');
    expect(controls.className).toContain('pointer-events-none');
  });

  it('2. Resets the 3-second auto-hide timer on mouse move, key press, or touch', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-reset-timer" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    const playerContainer = container.firstElementChild as HTMLElement;
    const controls = getByTestId('player-controls');

    act(() => {
      fireEvent.play(video);
    });

    // Advance 2s
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(controls.className).toContain('opacity-100');

    // Mouse move resets timer
    act(() => {
      fireEvent.mouseMove(playerContainer);
    });

    // Advance 2s more (total 4s from start, but 2s from mouse move) -> still visible
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(controls.className).toContain('opacity-100');

    // Key down resets timer
    act(() => {
      fireEvent.keyDown(window, { code: 'ArrowRight' });
    });

    // Advance 2s -> still visible
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(controls.className).toContain('opacity-100');

    // Touch start resets timer
    act(() => {
      fireEvent.touchStart(playerContainer);
    });

    // Advance 2s -> still visible
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(controls.className).toContain('opacity-100');

    // Advance 1s more (3s from touch start) -> hides
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(controls.className).toContain('opacity-0');
  });

  it('3. Paused video always displays toolbar and NEVER auto-hides', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-paused" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    const controls = getByTestId('player-controls');

    act(() => {
      fireEvent.play(video);
      vi.advanceTimersByTime(3000);
    });
    expect(controls.className).toContain('opacity-0');

    // Pause the video
    act(() => {
      fireEvent.pause(video);
    });

    // Controls immediately appear
    expect(controls.className).toContain('opacity-100');

    // Advance a long period (10 seconds)
    act(() => {
      vi.advanceTimersByTime(10000);
    });

    // Still visible!
    expect(controls.className).toContain('opacity-100');
    expect(controls.className).not.toContain('opacity-0');
  });

  it('4. Opening mobile settings menu keeps toolbar visible and prevents auto-hide', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-menu-open" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    const controls = getByTestId('player-controls');
    const settingsButton = getByTestId('player-settings-button');

    act(() => {
      fireEvent.play(video);
    });

    // Open settings sheet
    act(() => {
      fireEvent.click(settingsButton);
    });

    // Controls remain visible indefinitely while settings is open
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(controls.className).toContain('opacity-100');
  });

  it('5. Touch on touch screen toggles toolbar on/off without toggling play/pause', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-touch-toggle" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    const controls = getByTestId('player-controls');
    const playSpy = vi.spyOn(video, 'play').mockImplementation(async () => {});
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {});

    act(() => {
      fireEvent.play(video);
    });

    // A real tap: touchstart (bubbles to the container) -> touchend -> synthetic click
    const tap = () => {
      act(() => {
        fireEvent.touchStart(video);
      });
      act(() => {
        fireEvent.touchEnd(video);
        fireEvent.click(video);
      });
    };

    // Visible -> hidden
    tap();
    expect(controls.className).toContain('opacity-0');

    // Hidden -> visible (the touchstart reveal must not be undone by touchend)
    tap();
    expect(controls.className).toContain('opacity-100');

    // Shown by tap, auto-hides again after 3s while playing
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(controls.className).toContain('opacity-0');

    // Does NOT toggle play or pause
    expect(playSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('5b. Tapping a paused video keeps the toolbar visible', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-touch-paused" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    const controls = getByTestId('player-controls');

    act(() => {
      fireEvent.touchStart(video);
    });
    act(() => {
      fireEvent.touchEnd(video);
      fireEvent.click(video);
    });
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(controls.className).toContain('opacity-100');
  });

  it('6. Fullscreen hides mouse cursor (cursor-none) when toolbar is hidden', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-fullscreen-cursor" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    const playerContainer = container.firstElementChild as HTMLElement;
    const fullscreenButton = getByTestId('fullscreen-button');

    // Stub requestFullscreen like a browser: set fullscreenElement, fire fullscreenchange
    playerContainer.requestFullscreen = vi.fn().mockImplementation(async () => {
      setFullscreenElement(playerContainer);
    });

    // Enter fullscreen
    act(() => {
      fireEvent.click(fullscreenButton);
    });

    // Start playback
    act(() => {
      fireEvent.play(video);
    });

    // Controls visible initially -> no cursor-none
    expect(playerContainer.className).not.toContain('cursor-none');
    expect(video.className).not.toContain('cursor-none');

    // Advance 3s -> toolbar auto-hides -> cursor-none applied
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(playerContainer.className).toContain('cursor-none');
    expect(video.className).toContain('cursor-none');

    // Mouse move brings cursor and controls back
    act(() => {
      fireEvent.mouseMove(playerContainer);
    });

    expect(playerContainer.className).not.toContain('cursor-none');
    expect(video.className).not.toContain('cursor-none');
  });

  it('7. Leaving fullscreen via the browser (back gesture / Esc) resets fullscreen state', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-fullscreen-exit" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );
    const playerContainer = container.firstElementChild as HTMLElement;
    const fullscreenButton = getByTestId('fullscreen-button');

    act(() => {
      setFullscreenElement(playerContainer);
    });
    expect(fullscreenButton.getAttribute('aria-label')).toContain('Thoát');

    act(() => {
      setFullscreenElement(null);
    });
    expect(fullscreenButton.getAttribute('aria-label')).not.toContain('Thoát');
  });

  it('8. iPhone Safari (no element fullscreen) falls back to native video fullscreen', () => {
    const { container, getByTestId } = render(
      <VideoPlayer videoId="vid-fullscreen-ios" src="https://cdn.winkey.vn/hls/master.m3u8" />,
    );
    const video = container.querySelector('video') as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    const playerContainer = container.firstElementChild as HTMLElement;
    Object.defineProperty(playerContainer, 'requestFullscreen', {
      configurable: true,
      value: undefined,
    });
    video.webkitEnterFullscreen = vi.fn();

    act(() => {
      fireEvent.click(getByTestId('fullscreen-button'));
    });
    expect(video.webkitEnterFullscreen).toHaveBeenCalledTimes(1);
  });
});

function setFullscreenElement(el: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: el });
  document.dispatchEvent(new Event('fullscreenchange'));
}
