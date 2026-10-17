import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { VideoPlayer } from '../src/components/video/video-player';
import { PlaybackTracker } from '../src/lib/video/playback-tracker';
import type { Rendition } from '@winkey/api-client';

type HlsHandler = (event: string, data: unknown) => void;

interface MockHlsInstance {
  handlers: Record<string, HlsHandler[]>;
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  on: (event: string, cb: HlsHandler) => void;
  emit: (event: string, data: unknown) => void;
  destroy: ReturnType<typeof vi.fn>;
  currentLevel: number;
  levels: Array<{ height: number; bitrate: number; name: string }>;
}

let latestHlsInstance: MockHlsInstance | null = null;
let isHlsSupportedValue = true;

vi.mock('hls.js', () => {
  const isSupportedMock = vi.fn().mockImplementation(() => isHlsSupportedValue);
  const HlsMock = vi.fn().mockImplementation(() => {
    const handlers: Record<string, HlsHandler[]> = {};
    const instance: MockHlsInstance = {
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
    AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
    AUDIO_TRACK_SWITCHED: 'hlsAudioTrackSwitched',
  };
  (HlsMock as unknown as Record<string, unknown>).ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
    OTHER_ERROR: 'otherError',
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

const mockRenditions: Rendition[] = [
  { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000, codec: 'h264' },
  { name: '720p', width: 1280, height: 720, bitrate_kbps: 2800, codec: 'h264' },
  { name: '1080p', width: 1920, height: 1080, bitrate_kbps: 3000, codec: 'av1' },
  { name: '720p', width: 1280, height: 720, bitrate_kbps: 1700, codec: 'av1' },
  { name: '480p', width: 854, height: 480, bitrate_kbps: 1400 }, // Legacy missing codec -> treated as h264
];

describe('VideoPlayer AV1 Playback Support (ADR-041 ENC2)', () => {
  const hlsUrl = 'https://cdn.winkey.vn/hls/test-vid/master.m3u8';
  const hlsAv1Url = 'https://cdn.winkey.vn/hls-av1/test-vid/master.m3u8';

  beforeEach(() => {
    vi.clearAllMocks();
    latestHlsInstance = null;
    isHlsSupportedValue = true;
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Case 1: loads hls_av1_url when hls_av1_url is present and MediaSource supports AV1', () => {
    vi.stubGlobal('MediaSource', {
      isTypeSupported: vi.fn().mockImplementation((type: string) => {
        return type.includes('av01');
      }),
    });

    render(
      <VideoPlayer
        videoId="vid-av1"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        renditions={mockRenditions}
      />,
    );

    expect(latestHlsInstance).not.toBeNull();
    expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsAv1Url);
  });

  it('Case 2: falls back to hls_url when MediaSource does NOT support AV1', () => {
    vi.stubGlobal('MediaSource', {
      isTypeSupported: vi.fn().mockReturnValue(false),
    });

    render(
      <VideoPlayer
        videoId="vid-h264-fallback"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        renditions={mockRenditions}
      />,
    );

    expect(latestHlsInstance).not.toBeNull();
    expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsUrl);
  });

  it('Case 3: plays hls_url when hlsAv1Url is null/absent even if MediaSource supports AV1', () => {
    vi.stubGlobal('MediaSource', {
      isTypeSupported: vi.fn().mockReturnValue(true),
    });

    render(
      <VideoPlayer
        videoId="vid-no-av1"
        src={hlsUrl}
        hlsAv1Url={null}
        renditions={mockRenditions}
      />,
    );

    expect(latestHlsInstance).not.toBeNull();
    expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsUrl);
  });

  it('Case 4: Native Safari HLS with AV1 selects AV1 src, hides QualityMenu, and sets initial AV1 rendition', () => {
    isHlsSupportedValue = false; // Trigger native HLS path

    vi.stubGlobal('MediaSource', {
      isTypeSupported: vi.fn().mockImplementation((type: string) => type.includes('av01')),
    });

    const setRenditionSpy = vi.spyOn(PlaybackTracker.prototype, 'setRendition');

    // Mock HTMLMediaElement.prototype.canPlayType for Safari HLS
    const canPlayTypeSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation((type: string) => {
        if (type === 'application/vnd.apple.mpegurl') return 'maybe';
        return '';
      });

    const { container } = render(
      <VideoPlayer
        videoId="vid-safari-av1"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        renditions={mockRenditions}
      />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.src).toBe(hlsAv1Url);

    // QualityMenu is gated on isUsingHls, which is false in native Safari HLS
    expect(screen.queryByTestId('quality-menu-button')).toBeNull();

    // Initial rendition tracked from activeRenditions[0] (AV1 1080p, 3000 kbps, not H.264 5000 kbps)
    expect(setRenditionSpy).toHaveBeenCalledWith('1080p', 3000);

    canPlayTypeSpy.mockRestore();
    setRenditionSpy.mockRestore();
  });

  it('Case 5: Native Safari HLS without AV1 selects H.264 src, hides QualityMenu, and sets initial H.264 rendition', () => {
    isHlsSupportedValue = false;

    vi.stubGlobal('MediaSource', {
      isTypeSupported: vi.fn().mockReturnValue(false),
    });

    const setRenditionSpy = vi.spyOn(PlaybackTracker.prototype, 'setRendition');

    const canPlayTypeSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation((type: string) => {
        if (type === 'application/vnd.apple.mpegurl') return 'maybe';
        return '';
      });

    const { container } = render(
      <VideoPlayer
        videoId="vid-safari-h264"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        renditions={mockRenditions}
      />,
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.src).toBe(hlsUrl);

    // QualityMenu is gated on isUsingHls, which is false in native Safari HLS
    expect(screen.queryByTestId('quality-menu-button')).toBeNull();

    // Initial rendition tracked from activeRenditions[0] (H.264 1080p, 5000 kbps, not AV1 3000 kbps)
    expect(setRenditionSpy).toHaveBeenCalledWith('1080p', 5000);

    canPlayTypeSpy.mockRestore();
    setRenditionSpy.mockRestore();
  });

  it('Case 6: does NOT switch codec mid-playback even if MediaSource capability changes', () => {
    let supported = true;
    vi.stubGlobal('MediaSource', {
      isTypeSupported: vi.fn().mockImplementation(() => supported),
    });

    const { rerender } = render(
      <VideoPlayer
        videoId="vid-no-switch"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        renditions={mockRenditions}
      />,
    );

    expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsAv1Url);

    // Capability changes mid-session
    supported = false;

    // Rerender with arbitrary prop updates (e.g. title)
    rerender(
      <VideoPlayer
        videoId="vid-no-switch"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        title="Updated Title"
        renditions={mockRenditions}
      />,
    );

    // Must NOT switch back to H.264
    expect(latestHlsInstance?.loadSource).not.toHaveBeenCalledWith(hlsUrl);
  });
});
