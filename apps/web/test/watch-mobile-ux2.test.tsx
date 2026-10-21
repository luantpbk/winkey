import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlayerSettingsSheet } from '../src/components/video/player-settings-sheet';
import { VideoPlayer } from '../src/components/video/video-player';
import { CcMenu } from '../src/components/video/cc-menu';
import { WatchClientSection } from '../src/app/[locale]/watch/[id]/watch-client';
import { LikeButton } from '../src/components/social/like-button';
import { SubscribeButton } from '../src/components/social/subscribe-button';
import type { Video, SubtitleTrack } from '@winkey/api-client';

beforeAll(() => {
  global.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
});

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock Hls.js
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
      emit: vi.fn(),
      destroy: vi.fn(),
      startLoad: vi.fn(),
      recoverMediaError: vi.fn(),
      currentLevel: -1,
      levels: [
        { height: 1080, bitrate: 5000000, name: '1080p' },
        { height: 720, bitrate: 2800000, name: '720p' },
      ],
    };
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

// Mock routing Link, useRouter, usePathname
vi.mock('../src/i18n/routing', () => ({
  Link: ({ children, href, className, ...props }: any) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/watch/v1',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Mock auth context
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'user-viewer', display_name: 'Viewer' },
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

// Mock toast
vi.mock('../src/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

describe('UX2: Mobile Watch Page and Player Controls (ADR-045)', () => {
  describe('1. PlayerSettingsSheet Component', () => {
    const mockSubtitles: SubtitleTrack[] = [
      {
        lang: 'vi',
        label: 'Tiếng Việt',
        source: 'UPLOAD',
        url: 'https://example.com/vi.vtt',
        updated_at: '2026-10-21T00:00:00Z',
      },
      {
        lang: 'en',
        label: 'English',
        source: 'UPLOAD',
        url: 'https://example.com/en.vtt',
        updated_at: '2026-10-21T00:00:00Z',
      },
    ];

    const mockAudioTracks = [
      { index: 0, lang: 'vi', label: 'Tiếng Việt (Gốc)', isDefault: true },
      { index: 1, lang: 'en', label: 'Tiếng Anh (Lồng tiếng)' },
    ];

    const mockQualityLevels = [
      { index: -1, label: 'Tự động (1080p)' },
      { index: 0, label: '1080p', height: 1080 },
      { index: 1, label: '720p', height: 720 },
      { index: 2, label: '480p', height: 480 },
    ];

    it('renders main settings sheet with rows for Quality, Subtitles, and Audio', () => {
      render(
        <PlayerSettingsSheet
          isOpen={true}
          onClose={vi.fn()}
          subtitles={mockSubtitles}
          selectedSubtitleLang="vi"
          onSelectSubtitle={vi.fn()}
          audioTracks={mockAudioTracks}
          selectedAudioIndex={0}
          onSelectAudio={vi.fn()}
          qualityLevels={mockQualityLevels}
          currentLevel={-1}
          currentHeight={1080}
          onSelectQuality={vi.fn()}
        />,
      );

      expect(screen.getByTestId('player-settings-sheet')).toBeDefined();
      expect(screen.getByText('Cài đặt phát lại')).toBeDefined();
      expect(screen.getByTestId('settings-row-quality')).toBeDefined();
      expect(screen.getByTestId('settings-row-subtitles')).toBeDefined();
      expect(screen.getByTestId('settings-row-audio')).toBeDefined();
    });

    it('navigates into Subtitles list, selects track and calls onSelectSubtitle', () => {
      const handleSelectSubtitle = vi.fn();
      const handleClose = vi.fn();

      render(
        <PlayerSettingsSheet
          isOpen={true}
          onClose={handleClose}
          subtitles={mockSubtitles}
          selectedSubtitleLang="vi"
          onSelectSubtitle={handleSelectSubtitle}
          audioTracks={mockAudioTracks}
          selectedAudioIndex={0}
          onSelectAudio={vi.fn()}
          qualityLevels={mockQualityLevels}
          currentLevel={-1}
          currentHeight={1080}
          onSelectQuality={vi.fn()}
        />,
      );

      // Click Subtitles row
      fireEvent.click(screen.getByTestId('settings-row-subtitles'));

      // In subtitles view, check options
      expect(screen.getByTestId('settings-option-cc-off')).toBeDefined();
      expect(screen.getByTestId('settings-option-cc-vi')).toBeDefined();
      expect(screen.getByTestId('settings-option-cc-en')).toBeDefined();

      // Click English option
      fireEvent.click(screen.getByTestId('settings-option-cc-en'));
      expect(handleSelectSubtitle).toHaveBeenCalledWith('en');
      expect(handleClose).toHaveBeenCalled();
    });

    it('navigates into Audio list and selects track', () => {
      const handleSelectAudio = vi.fn();
      const handleClose = vi.fn();

      render(
        <PlayerSettingsSheet
          isOpen={true}
          onClose={handleClose}
          subtitles={mockSubtitles}
          selectedSubtitleLang="vi"
          onSelectSubtitle={vi.fn()}
          audioTracks={mockAudioTracks}
          selectedAudioIndex={0}
          onSelectAudio={handleSelectAudio}
          qualityLevels={mockQualityLevels}
          currentLevel={-1}
          currentHeight={1080}
          onSelectQuality={vi.fn()}
        />,
      );

      // Click Audio row
      fireEvent.click(screen.getByTestId('settings-row-audio'));

      // Click second track
      fireEvent.click(screen.getByTestId('settings-option-audio-1'));
      expect(handleSelectAudio).toHaveBeenCalledWith(mockAudioTracks[1]);
      expect(handleClose).toHaveBeenCalled();
    });

    it('navigates into Quality list and selects level', () => {
      const handleSelectQuality = vi.fn();
      const handleClose = vi.fn();

      render(
        <PlayerSettingsSheet
          isOpen={true}
          onClose={handleClose}
          subtitles={mockSubtitles}
          selectedSubtitleLang="vi"
          onSelectSubtitle={vi.fn()}
          audioTracks={mockAudioTracks}
          selectedAudioIndex={0}
          onSelectAudio={vi.fn()}
          qualityLevels={mockQualityLevels}
          currentLevel={-1}
          currentHeight={1080}
          onSelectQuality={handleSelectQuality}
        />,
      );

      // Click Quality row
      fireEvent.click(screen.getByTestId('settings-row-quality'));

      // Click 720p option
      fireEvent.click(screen.getByTestId('settings-option-quality-1'));
      expect(handleSelectQuality).toHaveBeenCalledWith(1);
      expect(handleClose).toHaveBeenCalled();
    });

    it('navigates back to main menu with Back button', () => {
      render(
        <PlayerSettingsSheet
          isOpen={true}
          onClose={vi.fn()}
          subtitles={mockSubtitles}
          selectedSubtitleLang="vi"
          onSelectSubtitle={vi.fn()}
          audioTracks={mockAudioTracks}
          selectedAudioIndex={0}
          onSelectAudio={vi.fn()}
          qualityLevels={mockQualityLevels}
          currentLevel={-1}
          currentHeight={1080}
          onSelectQuality={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('settings-row-quality'));
      expect(screen.getByTestId('settings-back-btn')).toBeDefined();

      fireEvent.click(screen.getByTestId('settings-back-btn'));
      expect(screen.getByText('Cài đặt phát lại')).toBeDefined();
    });

    it('closes on backdrop click or close button', () => {
      const handleClose = vi.fn();
      render(
        <PlayerSettingsSheet
          isOpen={true}
          onClose={handleClose}
          subtitles={mockSubtitles}
          selectedSubtitleLang="vi"
          onSelectSubtitle={vi.fn()}
          audioTracks={mockAudioTracks}
          selectedAudioIndex={0}
          onSelectAudio={vi.fn()}
          qualityLevels={mockQualityLevels}
          currentLevel={-1}
          currentHeight={1080}
          onSelectQuality={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('settings-close-btn'));
      expect(handleClose).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('player-settings-backdrop'));
      expect(handleClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('2. Subtitles Active Styling in CcMenu', () => {
    it('uses non-solid red background for active subtitles (text-[#FF4D6D], no bg-red-600)', () => {
      const mockTracks: SubtitleTrack[] = [
        {
          lang: 'vi',
          label: 'Tiếng Việt',
          source: 'UPLOAD',
          url: 'https://example.com/vi.vtt',
          updated_at: '2026-10-21T00:00:00Z',
        },
      ];

      render(<CcMenu tracks={mockTracks} selectedLang="vi" onSelectTrack={vi.fn()} />);

      const button = screen.getByTestId('cc-menu-button');
      // Must not use solid red background
      expect(button.className).not.toContain('bg-red-600');
      // Must use active indicator
      expect(button.className).toContain('text-[#FF4D6D]');
    });
  });

  describe('3. Action Row & Channel Row in WatchClientSection', () => {
    const mockVideo: Video = {
      id: 'vid-watch-1',
      title: 'Thiên Cơ Biến Tập 3',
      description: 'Mô tả tập 3 bộ phim',
      duration_ms: 120000,
      published_at: new Date().toISOString(),
      visibility: 'public',
      status: 'READY',
      view_count: 1500,
      like_count: 240,
      tags: ['phim', 'hanh-dong'],
      owner: {
        id: 'owner-channel-1',
        display_name: 'Studio Winkey',
        handle: 'studio-winkey',
        avatar_url: null,
      },
      playback: {
        hls_url: 'https://example.com/master.m3u8',
      },
    } as any;

    it('renders horizontally scrollable action bar with no-scrollbar class', () => {
      render(<WatchClientSection video={mockVideo} />);

      const actionBar = screen.getByTestId('watch-action-bar');
      expect(actionBar.className).toContain('overflow-x-auto');
      expect(actionBar.className).toContain('no-scrollbar');
    });

    it('all action buttons have equal height (h-10 / 40px) and single-line whitespace-nowrap', () => {
      render(<WatchClientSection video={mockVideo} />);

      const shareBtn = screen.getByTestId('watch-share-btn');
      expect(shareBtn.className).toContain('h-10');
      expect(shareBtn.className).toContain('whitespace-nowrap');
      expect(shareBtn.className).toContain('shrink-0');

      const watchLaterBtn = screen.getByTestId('watch-page-watch-later-btn');
      expect(watchLaterBtn.className).toContain('h-10');
      expect(watchLaterBtn.className).toContain('whitespace-nowrap');
      expect(watchLaterBtn.className).toContain('shrink-0');

      const saveBtn = screen.getByTestId('watch-page-save-btn');
      expect(saveBtn.className).toContain('h-10');
      expect(saveBtn.className).toContain('whitespace-nowrap');
      expect(saveBtn.className).toContain('shrink-0');

      const reportBtn = screen.getByTestId('watch-report-btn');
      expect(reportBtn.className).toContain('h-10');
      expect(reportBtn.className).toContain('shrink-0');
    });

    it('LikeButton has h-10 and whitespace-nowrap', () => {
      render(<LikeButton videoId="test-vid" initialLikeCount={50} />);
      const likeBtn = screen.getByRole('button', { name: /like/i });
      expect(likeBtn.className).toContain('h-10');
      expect(likeBtn.className).toContain('whitespace-nowrap');
      expect(likeBtn.className).toContain('shrink-0');
    });

    it('SubscribeButton has shrink-0 and fixed normal size', () => {
      render(<SubscribeButton channelId="other-channel" />);
      const subBtn = screen.getByRole('button', { name: /subscribe/i });
      expect(subBtn.className).toContain('shrink-0');
      expect(subBtn.className).toContain('h-10');
    });
  });

  describe('4. VideoPlayer Mobile Controls & Settings Button', () => {
    it('renders player-settings-button with >= 44px hit area and opens sheet on click', () => {
      render(
        <VideoPlayer
          videoId="vid-p1"
          src="https://example.com/master.m3u8"
          title="Video Player Test"
        />,
      );

      const settingsBtn = screen.getByTestId('player-settings-button');
      expect(settingsBtn).toBeDefined();
      expect(settingsBtn.className).toContain('before:-inset-1');

      // Click settings button
      fireEvent.click(settingsBtn);

      // Sheet appears
      expect(screen.getByTestId('player-settings-sheet')).toBeDefined();
    });
  });
});
