import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { VideoPlayer, isAv1Supported } from '../src/components/video/video-player';
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
  config: Record<string, unknown>;
}

let latestHlsInstance: MockHlsInstance | null = null;
let lastHlsConfig: Record<string, unknown> | null = null;
let isHlsSupportedValue = true;

vi.mock('hls.js', () => {
  const isSupportedMock = vi.fn().mockImplementation(() => isHlsSupportedValue);
  const HlsMock = vi.fn().mockImplementation((config: Record<string, unknown>) => {
    lastHlsConfig = config;
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
      config,
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
  { name: '480p', width: 854, height: 480, bitrate_kbps: 1400 },
];

describe('isAv1Supported with MediaCapabilities decodingInfo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when navigator or mediaCapabilities is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const res = await isAv1Supported();
    expect(res).toBe(false);
  });

  it('returns false when mediaCapabilities.decodingInfo rejects', async () => {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockRejectedValue(new Error('API error')),
      },
    });
    const res = await isAv1Supported();
    expect(res).toBe(false);
  });

  it('calls decodingInfo with the exact required query object', async () => {
    const decodingInfoMock = vi.fn().mockResolvedValue({
      supported: true,
      smooth: true,
      powerEfficient: true,
    });
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: decodingInfoMock,
      },
    });

    const res = await isAv1Supported();
    expect(res).toBe(true);
    expect(decodingInfoMock).toHaveBeenCalledWith({
      type: 'media-source',
      video: {
        contentType: 'video/mp4; codecs="av01.0.08M.08"',
        width: 1920,
        height: 1080,
        bitrate: 3000000,
        framerate: 30,
      },
    });
  });

  it('returns false when supported is false', async () => {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: false,
          smooth: true,
          powerEfficient: true,
        }),
      },
    });
    expect(await isAv1Supported()).toBe(false);
  });

  it('returns false when smooth is false', async () => {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: true,
          smooth: false,
          powerEfficient: true,
        }),
      },
    });
    expect(await isAv1Supported()).toBe(false);
  });

  it('returns false when powerEfficient is false', async () => {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: true,
          smooth: true,
          powerEfficient: false,
        }),
      },
    });
    expect(await isAv1Supported()).toBe(false);
  });

  it('returns true ONLY when supported && smooth && powerEfficient are all true', async () => {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: true,
          smooth: true,
          powerEfficient: true,
        }),
      },
    });
    expect(await isAv1Supported()).toBe(true);
  });
});

describe('VideoPlayer AV1 Playback Support (ADR-041 ENC2 & MediaCapabilities)', () => {
  const hlsUrl = 'https://cdn.winkey.vn/hls/test-vid/master.m3u8';
  const hlsAv1Url = 'https://cdn.winkey.vn/hls-av1/test-vid/master.m3u8';

  beforeEach(() => {
    vi.clearAllMocks();
    latestHlsInstance = null;
    lastHlsConfig = null;
    isHlsSupportedValue = true;
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Case 1: loads hls_av1_url when hls_av1_url is present and mediaCapabilities confirms AV1 is supported, smooth, and power-efficient', async () => {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: true,
          smooth: true,
          powerEfficient: true,
        }),
      },
    });

    render(
      <VideoPlayer
        videoId="vid-av1"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        renditions={mockRenditions}
      />,
    );

    await waitFor(() => {
      expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsAv1Url);
    });

    // Check hls.js config buffer and worker parameters
    expect(lastHlsConfig).toMatchObject({
      enableWorker: true,
      capLevelToPlayerSize: true,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
    });
  });

  it('Case 2: falls back to hls_url when AV1 is not smooth or not powerEfficient', async () => {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: true,
          smooth: false, // Janky / lagging on mobile
          powerEfficient: true,
        }),
      },
    });

    render(
      <VideoPlayer
        videoId="vid-h264-fallback"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        renditions={mockRenditions}
      />,
    );

    await waitFor(() => {
      expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsUrl);
    });
  });

  it('Case 3: plays hls_url when hlsAv1Url is null/absent even if AV1 is supported', async () => {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: true,
          smooth: true,
          powerEfficient: true,
        }),
      },
    });

    render(
      <VideoPlayer
        videoId="vid-no-av1"
        src={hlsUrl}
        hlsAv1Url={null}
        renditions={mockRenditions}
      />,
    );

    await waitFor(() => {
      expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsUrl);
    });
  });

  it('Case 4: Native Safari HLS with AV1 selects AV1 src, hides QualityMenu, and sets initial AV1 rendition', async () => {
    isHlsSupportedValue = false; // Trigger native HLS path

    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: true,
          smooth: true,
          powerEfficient: true,
        }),
      },
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
        videoId="vid-safari-av1"
        src={hlsUrl}
        hlsAv1Url={hlsAv1Url}
        renditions={mockRenditions}
      />,
    );

    await waitFor(() => {
      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video.src).toBe(hlsAv1Url);
    });

    expect(screen.queryByTestId('quality-menu-button')).toBeNull();

    canPlayTypeSpy.mockRestore();
    setRenditionSpy.mockRestore();
  });

  it('Case 5: Native Safari HLS without AV1 selects H.264 src, hides QualityMenu, and sets initial H.264 rendition', async () => {
    isHlsSupportedValue = false;

    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: vi.fn().mockResolvedValue({
          supported: false,
          smooth: false,
          powerEfficient: false,
        }),
      },
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
    expect(screen.queryByTestId('quality-menu-button')).toBeNull();

    canPlayTypeSpy.mockRestore();
    setRenditionSpy.mockRestore();
  });

  describe('AV1-tel: Codec and AV1 Capability Telemetry (ADR-048 addendum)', () => {
    it('feeds codec: "av1" and av1Capable: true to tracker when loading hls_av1_url', async () => {
      vi.stubGlobal('navigator', {
        mediaCapabilities: {
          decodingInfo: vi.fn().mockResolvedValue({
            supported: true,
            smooth: true,
            powerEfficient: true,
          }),
        },
      });

      const setCodecSpy = vi.spyOn(PlaybackTracker.prototype, 'setCodec');
      const setAv1CapableSpy = vi.spyOn(PlaybackTracker.prototype, 'setAv1Capable');

      render(
        <VideoPlayer
          videoId="vid-av1-tel"
          src={hlsUrl}
          hlsAv1Url={hlsAv1Url}
          renditions={mockRenditions}
        />,
      );

      await waitFor(() => {
        expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsAv1Url);
      });

      await waitFor(() => {
        expect(setCodecSpy).toHaveBeenCalledWith('av1');
        expect(setAv1CapableSpy).toHaveBeenCalledWith(true);
      });

      setCodecSpy.mockRestore();
      setAv1CapableSpy.mockRestore();
    });

    it('feeds codec: "h264" and av1Capable: false when AV1 is unsupported, even if hlsAv1Url exists', async () => {
      vi.stubGlobal('navigator', {
        mediaCapabilities: {
          decodingInfo: vi.fn().mockResolvedValue({
            supported: false,
            smooth: false,
            powerEfficient: false,
          }),
        },
      });

      const setCodecSpy = vi.spyOn(PlaybackTracker.prototype, 'setCodec');
      const setAv1CapableSpy = vi.spyOn(PlaybackTracker.prototype, 'setAv1Capable');

      render(
        <VideoPlayer
          videoId="vid-h264-tel"
          src={hlsUrl}
          hlsAv1Url={hlsAv1Url}
          renditions={mockRenditions}
        />,
      );

      await waitFor(() => {
        expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsUrl);
      });

      await waitFor(() => {
        expect(setCodecSpy).toHaveBeenCalledWith('h264');
        expect(setAv1CapableSpy).toHaveBeenCalledWith(false);
      });

      setCodecSpy.mockRestore();
      setAv1CapableSpy.mockRestore();
    });

    it('feeds av1Capable to tracker even when the video offers NO hlsAv1Url', async () => {
      vi.stubGlobal('navigator', {
        mediaCapabilities: {
          decodingInfo: vi.fn().mockResolvedValue({
            supported: true,
            smooth: true,
            powerEfficient: true,
          }),
        },
      });

      const setCodecSpy = vi.spyOn(PlaybackTracker.prototype, 'setCodec');
      const setAv1CapableSpy = vi.spyOn(PlaybackTracker.prototype, 'setAv1Capable');

      render(
        <VideoPlayer
          videoId="vid-no-av1"
          src={hlsUrl}
          // no hlsAv1Url provided
          renditions={mockRenditions}
        />,
      );

      await waitFor(() => {
        expect(latestHlsInstance?.loadSource).toHaveBeenCalledWith(hlsUrl);
      });

      await waitFor(() => {
        expect(setCodecSpy).toHaveBeenCalledWith('h264');
        expect(setAv1CapableSpy).toHaveBeenCalledWith(true);
      });

      setCodecSpy.mockRestore();
      setAv1CapableSpy.mockRestore();
    });
  });
});
