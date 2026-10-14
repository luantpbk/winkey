import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MediaPackageUploadSection } from '../src/components/studio/media-package-upload-section';
import * as packageLoader from '../src/lib/media-package/package-loader';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

const activeLocale = 'vi';
const translatorMap = new Map<string, (key: string, values?: Record<string, unknown>) => string>();

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const nsKey = `${activeLocale}:${namespace ?? ''}`;
    let fn = translatorMap.get(nsKey);
    if (!fn) {
      fn = (key: string, values?: Record<string, unknown>) => {
        const isVi = activeLocale === 'vi';
        const fullPath = namespace ? `${namespace}.${key}` : key;
        const parts = fullPath.split('.');
        let cur: unknown = isVi ? viMessages : enMessages;
        for (const p of parts) {
          if (cur && typeof cur === 'object' && p in cur) {
            cur = (cur as Record<string, unknown>)[p];
          } else {
            return key;
          }
        }
        if (typeof cur === 'string') {
          let res = cur;
          if (values) {
            for (const [k, v] of Object.entries(values)) {
              res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
          }
          return res;
        }
        return key;
      };
      translatorMap.set(nsKey, fn);
    }
    return fn;
  },
}));

vi.mock('../src/i18n/routing', () => ({
  Link: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// Mock PackageUploader
let mockStartFn = vi.fn();
vi.mock('../src/lib/uploader/package-uploader', () => ({
  PackageUploader: class MockPackageUploader {
    private options: any;
    constructor(options: any) {
      this.options = options;
    }
    async start() {
      mockStartFn();
      this.options.onProgress?.({
        videoId: 'vid-success-456',
        overallPercent: 100,
        status: 'completed',
        video: { percent: 100, status: 'completed', speedMBps: 10, etaSeconds: 0 },
        audioTracks: [],
        subtitles: [],
      });
      return 'vid-success-456';
    }
    async cancel() {}
  },
}));

describe('MediaPackageUploadSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartFn = vi.fn();
  });

  const validLoadedPackage: packageLoader.LoadedMediaPackage = {
    manifest: {
      schema: 'winkey.media-package/v1',
      title: 'Phim Hài Tết',
      description: 'Phim tết vui nhộn',
      visibility: 'PUBLIC',
      video: { file: 'movie.mp4' },
      audio_tracks: [
        {
          file: 'audio/vi.wav',
          lang: 'vi',
          kind: 'dub',
          label: 'Lồng tiếng miền Nam',
          default: true,
        },
      ],
      subtitles: [
        {
          file: 'subtitles/en.vtt',
          lang: 'en',
          kind: 'captions',
          label: 'English CC',
        },
      ],
    },
    manifestRaw: '{}',
    videoFile: new File(['video'], 'movie.mp4', { type: 'video/mp4' }),
    audioTracks: [
      {
        meta: {
          file: 'audio/vi.wav',
          lang: 'vi',
          kind: 'dub',
          label: 'Lồng tiếng miền Nam',
          default: true,
        },
        file: new File(['audio'], 'vi.wav', { type: 'audio/wav' }),
      },
    ],
    subtitles: [
      {
        meta: {
          file: 'subtitles/en.vtt',
          lang: 'en',
          kind: 'captions',
          label: 'English CC',
        },
        file: new File(['sub'], 'en.vtt', { type: 'text/vtt' }),
        content: 'WEBVTT\n\n1',
      },
    ],
    allFilePaths: ['manifest.json', 'movie.mp4', 'audio/vi.wav', 'subtitles/en.vtt'],
  };

  it('renders initial dropzone with folder and zip picker buttons', () => {
    render(<MediaPackageUploadSection />);

    expect(screen.getByTestId('studio-media-package-section')).toBeTruthy();
    expect(screen.getByTestId('package-dropzone')).toBeTruthy();
    expect(screen.getByTestId('choose-folder-button')).toBeTruthy();
    expect(screen.getByTestId('choose-zip-button')).toBeTruthy();
  });

  it('displays validation errors when package is invalid', async () => {
    vi.spyOn(packageLoader, 'loadPackageFromFiles').mockResolvedValue({
      success: false,
      errors: ['manifest.json không đúng định dạng', 'Mã ngôn ngữ xx-yy không hợp lệ'],
    });

    render(<MediaPackageUploadSection />);

    const folderInput = screen.getByTestId('package-folder-input');
    const dummyFile = new File(['{}'], 'manifest.json', { type: 'application/json' });
    fireEvent.change(folderInput, { target: { files: [dummyFile] } });

    await waitFor(() => {
      const errorSection = screen.getByTestId('package-validation-errors');
      expect(errorSection).toBeTruthy();
      expect(errorSection.textContent).toContain('manifest.json không đúng định dạng');
      expect(errorSection.textContent).toContain('Mã ngôn ngữ xx-yy không hợp lệ');
    });
  });

  it('renders package preview and executes upload flow', async () => {
    vi.spyOn(packageLoader, 'loadPackageFromZip').mockResolvedValue({
      success: true,
      package: validLoadedPackage,
      errors: [],
    });

    render(<MediaPackageUploadSection />);

    const zipInput = screen.getByTestId('package-zip-input');
    const zipFile = new File(['zip content'], 'package.zip', { type: 'application/zip' });
    fireEvent.change(zipInput, { target: { files: [zipFile] } });

    await waitFor(() => {
      expect(screen.getByTestId('package-preview-card')).toBeTruthy();
      expect(screen.getAllByText('Phim Hài Tết').length).toBeGreaterThan(0);
      expect(screen.getByTestId('package-audio-list')).toBeTruthy();
      expect(screen.getByTestId('package-subtitles-list')).toBeTruthy();
      expect(screen.getByText('Lồng tiếng miền Nam')).toBeTruthy();
      expect(screen.getByText('English CC')).toBeTruthy();
    });

    // Click upload
    const startUploadBtn = screen.getByTestId('start-package-upload-button');
    fireEvent.click(startUploadBtn);

    await waitFor(() => {
      expect(mockStartFn).toHaveBeenCalled();
      expect(screen.getByTestId('package-upload-success')).toBeTruthy();
      expect(screen.getByTestId('package-success-goto-edit').getAttribute('href')).toBe(
        '/studio/videos/vid-success-456/edit',
      );
      expect(screen.getByTestId('package-success-goto-watch').getAttribute('href')).toBe(
        '/watch/vid-success-456',
      );
    });
  });
});
