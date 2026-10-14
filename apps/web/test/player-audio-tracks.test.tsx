import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VideoPlayer } from '../src/components/video/video-player';
import type { PlaybackAudioTrack, SubtitleTrack } from '@winkey/api-client';

type HlsHandler = (event: string, data: unknown) => void;

interface MockHlsInstance {
  handlers: Record<string, HlsHandler[]>;
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  on: (event: string, cb: HlsHandler) => void;
  emit: (event: string, data: unknown) => void;
  destroy: ReturnType<typeof vi.fn>;
  audioTracks: Array<{ id: number; name: string; lang: string; default?: boolean }>;
  audioTrack: number;
  levels: Array<{ height: number; bitrate: number; name: string }>;
}

let _latestHlsInstance: MockHlsInstance | null = null;

vi.mock('hls.js', () => {
  const isSupportedMock = vi.fn().mockReturnValue(true);
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
      audioTracks: [],
      audioTrack: 0,
      levels: [{ height: 1080, bitrate: 5000000, name: '1080p' }],
    };
    _latestHlsInstance = instance;
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

const mockAudioTracks: PlaybackAudioTrack[] = [
  {
    id: '018f0000-0000-7000-8000-000000000001',
    lang: 'und',
    label: 'Âm thanh gốc',
    kind: 'original',
    is_default: true,
  },
  {
    id: '018f0000-0000-7000-8000-000000000002',
    lang: 'vi',
    label: 'Tiếng Việt (Lồng tiếng)',
    kind: 'dub',
    is_default: false,
  },
  {
    id: '018f0000-0000-7000-8000-000000000003',
    lang: 'en',
    label: 'English Commentary',
    kind: 'commentary',
    is_default: false,
  },
];

const mockSubtitles: SubtitleTrack[] = [
  {
    lang: 'vi',
    label: 'Tiếng Việt',
    kind: 'subtitles',
    source: 'UPLOAD',
    url: 'https://cdn.winkey.vn/subtitles/vi.vtt',
    updated_at: '2026-10-14T00:00:00Z',
  },
  {
    lang: 'en',
    label: 'English CC',
    kind: 'captions',
    source: 'UPLOAD',
    url: 'https://cdn.winkey.vn/subtitles/en.vtt',
    updated_at: '2026-10-14T00:00:00Z',
  },
];

describe('VideoPlayer Audio and Subtitle switching & persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    _latestHlsInstance = null;
  });

  it('hides audio menu when audioTracks is empty', () => {
    render(
      <VideoPlayer
        videoId="video-1"
        src="https://cdn.winkey.vn/hls/test/master.m3u8"
        audioTracks={[]}
      />,
    );

    expect(screen.queryByTestId('audio-menu-button')).toBeNull();
  });

  it('renders audio menu from audioTracks with labels before manifest loads, with original first', () => {
    render(
      <VideoPlayer
        videoId="video-1"
        src="https://cdn.winkey.vn/hls/test/master.m3u8"
        audioTracks={mockAudioTracks}
      />,
    );

    const audioButton = screen.getByTestId('audio-menu-button');
    expect(audioButton).toBeTruthy();
    expect(audioButton.textContent).toContain('Âm thanh gốc');

    // Open audio menu
    fireEvent.click(audioButton);
    expect(screen.getByTestId('audio-menu-dropdown')).toBeTruthy();
    expect(screen.getByTestId('audio-option-und')).toBeTruthy();
    expect(screen.getByTestId('audio-option-vi')).toBeTruthy();
    expect(screen.getByTestId('audio-option-en')).toBeTruthy();
  });

  it('switches audio track on click and saves preference to localStorage', () => {
    render(
      <VideoPlayer
        videoId="video-1"
        src="https://cdn.winkey.vn/hls/test/master.m3u8"
        audioTracks={mockAudioTracks}
      />,
    );

    const audioButton = screen.getByTestId('audio-menu-button');
    fireEvent.click(audioButton);

    const viOption = screen.getByTestId('audio-option-vi');
    fireEvent.click(viOption);

    // Check localStorage
    expect(localStorage.getItem('winkey.audio_lang')).toBe('vi');
    expect(audioButton.textContent).toContain('Tiếng Việt');
  });

  it('automatically applies remembered audio language on the next video when available', () => {
    localStorage.setItem('winkey.audio_lang', 'vi');

    render(
      <VideoPlayer
        videoId="video-2"
        src="https://cdn.winkey.vn/hls/test/master.m3u8"
        audioTracks={mockAudioTracks}
      />,
    );

    const audioButton = screen.getByTestId('audio-menu-button');
    expect(audioButton.textContent).toContain('Tiếng Việt');
  });

  it('renders subtitle menu, marks kind=captions as CC badge, and remembers preference', () => {
    render(
      <VideoPlayer
        videoId="video-1"
        src="https://cdn.winkey.vn/hls/test/master.m3u8"
        subtitles={mockSubtitles}
      />,
    );

    const ccButton = screen.getByTestId('cc-menu-button');
    expect(ccButton).toBeTruthy();

    fireEvent.click(ccButton);
    expect(screen.getByTestId('cc-menu-dropdown')).toBeTruthy();
    expect(screen.getByTestId('cc-option-off')).toBeTruthy();
    expect(screen.getByTestId('cc-option-vi')).toBeTruthy();
    expect(screen.getByTestId('cc-option-en')).toBeTruthy();

    // Check CC badge for captions kind
    expect(screen.getByTestId('cc-badge-en')).toBeTruthy();
    expect(screen.getByTestId('cc-badge-en').textContent).toBe('CC');
    expect(screen.queryByTestId('cc-badge-vi')).toBeNull();

    // Select English CC
    fireEvent.click(screen.getByTestId('cc-option-en'));
    expect(localStorage.getItem('winkey.subtitle_lang')).toBe('en');
  });

  it('automatically applies remembered subtitle language on the next video', () => {
    localStorage.setItem('winkey.subtitle_lang', 'en');

    render(
      <VideoPlayer
        videoId="video-3"
        src="https://cdn.winkey.vn/hls/test/master.m3u8"
        subtitles={mockSubtitles}
      />,
    );

    const ccButton = screen.getByTestId('cc-menu-button');
    expect(ccButton.textContent).toContain('English CC');
  });
});
