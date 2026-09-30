import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VideoSubtitlesSection } from '../src/components/studio/video-subtitles-section';
import { VideoSubtitlesDialog } from '../src/components/studio/video-subtitles-dialog';
import { api } from '../src/lib/api-client';
import type { Video } from '@winkey/api-client';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

// --- Locale Mock ---
let activeLocale: 'vi' | 'en' = 'vi';
export function setTestLocale(locale: 'vi' | 'en') {
  activeLocale = locale;
}

// Mock next-intl
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

// Mock api.video
vi.mock('../src/lib/api-client', () => ({
  api: {
    video: {
      GET: vi.fn(),
      PUT: vi.fn(),
      DELETE: vi.fn(),
    },
  },
}));

const mockVideoWithSubtitles: Video = {
  id: '018f1234-5678-7000-8000-000000000001',
  title: 'Test Video with Subtitles',
  description: 'Test description',
  status: 'READY',
  duration_ms: 120000,
  visibility: 'PUBLIC',
  width: 1920,
  height: 1080,
  view_count: 100,
  like_count: 10,
  published_at: '2026-09-30T10:00:00Z',
  created_at: '2026-09-30T10:00:00Z',
  owner: {
    id: 'user-1',
    handle: 'tester',
    display_name: 'Tester',
    avatar_url: null,
  },
  playback: {
    hls_url: 'https://cdn.winkey.vn/hls/test/master.m3u8',
    thumbnail_url: 'https://cdn.winkey.vn/thumbs/test.jpg',
    renditions: [{ name: '1080p', width: 1920, height: 1080, bitrate_kbps: 5000 }],
    subtitles: [
      {
        lang: 'vi',
        label: 'Tiếng Việt',
        source: 'UPLOAD',
        url: 'https://cdn.winkey.vn/subtitles/test/vi.vtt',
        updated_at: '2026-09-30T10:00:00Z',
      },
      {
        lang: 'en',
        label: 'English',
        source: 'UPLOAD',
        url: 'https://cdn.winkey.vn/subtitles/test/en.vtt',
        updated_at: '2026-09-30T10:05:00Z',
      },
    ],
  },
};

const mockVideoEmpty: Video = {
  ...mockVideoWithSubtitles,
  playback: {
    ...mockVideoWithSubtitles.playback!,
    subtitles: [],
  },
};

const mockVideoFailed: Video = {
  ...mockVideoWithSubtitles,
  status: 'FAILED',
};

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('Studio Subtitles Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTestLocale('vi');
    vi.mocked(api.video.GET).mockResolvedValue({
      data: mockVideoWithSubtitles,
      response: new Response(null, { status: 200 }),
    } as any);
  });

  it('renders track list with language badges and labels', async () => {
    renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    expect(screen.getByText('Phụ đề')).toBeTruthy();
    expect(screen.getByTestId('subtitle-row-vi')).toBeTruthy();
    expect(screen.getByTestId('subtitle-row-en')).toBeTruthy();
    expect(screen.getByText('Tiếng Việt')).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();
  });

  it('renders empty notice when no subtitles are present', async () => {
    vi.mocked(api.video.GET).mockResolvedValue({
      data: mockVideoEmpty,
      response: new Response(null, { status: 200 }),
    } as any);

    renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoEmpty}
      />,
    );

    expect(screen.getByTestId('no-subtitles-notice')).toBeTruthy();
  });

  it('rejects files larger than 512 KiB immediately on client side', async () => {
    renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    const fileInput = screen.getByTestId('subtitle-file-input') as HTMLInputElement;
    const largeFile = new File(['x'.repeat(600000)], 'large.vtt', { type: 'text/vtt' });
    Object.defineProperty(largeFile, 'size', { value: 600000 });

    fireEvent.change(fileInput, { target: { files: [largeFile] } });

    await waitFor(() => {
      const alert = screen.getByTestId('subtitles-error-alert');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('Tập tin phụ đề quá lớn (tối đa 512 KiB)');
    });
  });

  it('rejects files that do not start with WEBVTT', async () => {
    renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    const fileInput = screen.getByTestId('subtitle-file-input') as HTMLInputElement;
    const invalidFile = new File(['1\n00:00:00.000 --> 00:00:02.000\nHello'], 'invalid.srt', {
      type: 'text/plain',
    });

    // Mock FileReader
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((e: any) => void) | null = null;
      readAsText(_file: Blob) {
        setTimeout(() => {
          this.onload?.({ target: { result: '1\n00:00:00.000 --> 00:00:02.000\nHello' } });
        }, 10);
      }
    }
    (global as any).FileReader = MockFileReader;

    fireEvent.change(fileInput, { target: { files: [invalidFile] } });

    await waitFor(() => {
      const alert = screen.getByTestId('subtitles-error-alert');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('Tập tin WebVTT không hợp lệ');
    });

    global.FileReader = originalFileReader;
  });

  it('successfully uploads valid WebVTT track with preset language', async () => {
    vi.mocked(api.video.PUT).mockResolvedValue({
      data: mockVideoWithSubtitles,
      response: new Response(null, { status: 200 }),
    } as any);

    const onSuccess = vi.fn();
    renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
        onSuccess={onSuccess}
      />,
    );

    const fileInput = screen.getByTestId('subtitle-file-input') as HTMLInputElement;
    const validFile = new File(['WEBVTT\n\n00:00.000 --> 00:02.000\nXin chào'], 'sample.vtt', {
      type: 'text/vtt',
    });

    // Mock FileReader
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((e: any) => void) | null = null;
      readAsText(_file: Blob) {
        setTimeout(() => {
          this.onload?.({
            target: { result: 'WEBVTT\n\n00:00.000 --> 00:02.000\nXin chào' },
          });
        }, 10);
      }
    }
    (global as any).FileReader = MockFileReader;

    fireEvent.change(fileInput, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByText('sample.vtt')).toBeTruthy();
    });

    const submitBtn = screen.getByTestId('upload-subtitle-button') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.video.PUT).toHaveBeenCalledWith('/v1/videos/{video_id}/subtitles/{lang}', {
        params: {
          path: {
            video_id: '018f1234-5678-7000-8000-000000000001',
            lang: 'vi',
          },
        },
        body: {
          label: 'Tiếng Việt',
          content: 'WEBVTT\n\n00:00.000 --> 00:02.000\nXin chào',
        },
      });
      expect(screen.getByTestId('subtitles-success-alert')).toBeTruthy();
      expect(onSuccess).toHaveBeenCalled();
    });

    global.FileReader = originalFileReader;
  });

  it('validates custom BCP-47 tag input format', async () => {
    renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    // Select custom
    const langSelect = screen.getByTestId('subtitle-lang-select');
    fireEvent.change(langSelect, { target: { value: 'custom' } });

    expect(screen.getByTestId('subtitle-custom-lang-input')).toBeTruthy();

    const customInput = screen.getByTestId('subtitle-custom-lang-input');
    const labelInput = screen.getByTestId('subtitle-label-input');
    const fileInput = screen.getByTestId('subtitle-file-input');

    // Mock FileReader
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((e: any) => void) | null = null;
      readAsText(_file: Blob) {
        setTimeout(() => {
          this.onload?.({ target: { result: 'WEBVTT\n\n00:00.000 --> 00:01.000\nTest' } });
        }, 10);
      }
    }
    (global as any).FileReader = MockFileReader;

    fireEvent.change(fileInput, {
      target: { files: [new File(['WEBVTT\n\n1'], 'test.vtt', { type: 'text/vtt' })] },
    });

    await waitFor(() => {
      expect(screen.getByText('test.vtt')).toBeTruthy();
    });

    fireEvent.change(labelInput, { target: { value: 'Français' } });
    fireEvent.change(customInput, { target: { value: 'invalid_tag!' } });

    fireEvent.submit(screen.getByTestId('upload-subtitle-form'));

    await waitFor(() => {
      const alert = screen.getByTestId('subtitles-error-alert');
      expect(alert.textContent).toContain('Mã ngôn ngữ không đúng định dạng BCP-47');
    });

    expect(api.video.PUT).not.toHaveBeenCalled();

    // Now fix custom lang to valid 'fr-FR'
    vi.mocked(api.video.PUT).mockResolvedValue({
      data: mockVideoWithSubtitles,
      response: new Response(null, { status: 201 }),
    } as any);

    fireEvent.change(customInput, { target: { value: 'fr-FR' } });
    fireEvent.submit(screen.getByTestId('upload-subtitle-form'));

    await waitFor(() => {
      expect(api.video.PUT).toHaveBeenCalledWith('/v1/videos/{video_id}/subtitles/{lang}', {
        params: {
          path: {
            video_id: '018f1234-5678-7000-8000-000000000001',
            lang: 'fr-FR',
          },
        },
        body: {
          label: 'Français',
          content: 'WEBVTT\n\n00:00.000 --> 00:01.000\nTest',
        },
      });
    });

    global.FileReader = originalFileReader;
  });

  it('maps backend API error codes correctly (SUBTITLE_TOO_LARGE, INVALID_WEBVTT, TOO_MANY_SUBTITLES, 403, 404)', async () => {
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((e: any) => void) | null = null;
      readAsText(_file: Blob) {
        setTimeout(() => {
          this.onload?.({ target: { result: 'WEBVTT\n\n00:00.000 --> 00:01.000\nTest' } });
        }, 5);
      }
    }
    (global as any).FileReader = MockFileReader;

    const setupFormWithFile = async () => {
      const fileInput = screen.getByTestId('subtitle-file-input');
      fireEvent.change(fileInput, {
        target: { files: [new File(['WEBVTT'], 'test.vtt', { type: 'text/vtt' })] },
      });
      await waitFor(() => {
        expect(screen.getByText('test.vtt')).toBeTruthy();
      });
    };

    // 1. 400 SUBTITLE_TOO_LARGE
    vi.mocked(api.video.PUT).mockResolvedValueOnce({
      error: { code: 'SUBTITLE_TOO_LARGE', detail: 'Too large' },
      response: new Response(null, { status: 400 }),
    } as any);

    const { unmount } = renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    await setupFormWithFile();
    fireEvent.submit(screen.getByTestId('upload-subtitle-form'));

    await waitFor(() => {
      const alert = screen.getByTestId('subtitles-error-alert');
      expect(alert.textContent).toContain('Tập tin phụ đề quá lớn (tối đa 512 KiB)');
    });
    unmount();

    // 2. 400 INVALID_WEBVTT with line details
    vi.mocked(api.video.PUT).mockResolvedValueOnce({
      error: { code: 'INVALID_WEBVTT', detail: 'syntax error on line 4: bad timestamp' },
      response: new Response(null, { status: 400 }),
    } as any);

    const render2 = renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    await setupFormWithFile();
    fireEvent.submit(screen.getByTestId('upload-subtitle-form'));

    await waitFor(() => {
      const alert = screen.getByTestId('subtitles-error-alert');
      expect(alert.textContent).toContain('syntax error on line 4: bad timestamp');
    });
    render2.unmount();

    // 3. 409 TOO_MANY_SUBTITLES
    vi.mocked(api.video.PUT).mockResolvedValueOnce({
      error: { code: 'TOO_MANY_SUBTITLES', detail: 'Maximum 20 tracks allowed' },
      response: new Response(null, { status: 409 }),
    } as any);

    const render3 = renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    await setupFormWithFile();
    fireEvent.submit(screen.getByTestId('upload-subtitle-form'));

    await waitFor(() => {
      const alert = screen.getByTestId('subtitles-error-alert');
      expect(alert.textContent).toContain('Đã đạt giới hạn tối đa 20 bản phụ đề');
    });
    render3.unmount();

    // 4. 403 Forbidden
    vi.mocked(api.video.PUT).mockResolvedValueOnce({
      error: { code: 'FORBIDDEN', detail: 'Forbidden' },
      response: new Response(null, { status: 403 }),
    } as any);

    const render4 = renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    await setupFormWithFile();
    fireEvent.submit(screen.getByTestId('upload-subtitle-form'));

    await waitFor(() => {
      const alert = screen.getByTestId('subtitles-error-alert');
      expect(alert.textContent).toContain('Bạn không có quyền quản lý phụ đề cho video này');
    });
    render4.unmount();

    // 5. 404 Not Found
    vi.mocked(api.video.PUT).mockResolvedValueOnce({
      error: { code: 'NOT_FOUND', detail: 'Not found' },
      response: new Response(null, { status: 404 }),
    } as any);

    const render5 = renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    await setupFormWithFile();
    fireEvent.submit(screen.getByTestId('upload-subtitle-form'));

    await waitFor(() => {
      const alert = screen.getByTestId('subtitles-error-alert');
      expect(alert.textContent).toContain('Không tìm thấy video hoặc bản phụ đề');
    });
    render5.unmount();

    global.FileReader = originalFileReader;
  });

  it('disables upload and shows warning when video status is FAILED', async () => {
    vi.mocked(api.video.GET).mockResolvedValue({
      data: mockVideoFailed,
      response: new Response(null, { status: 200 }),
    } as any);

    renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoFailed}
      />,
    );

    expect(screen.getByText('Không thể thêm phụ đề cho video bị lỗi')).toBeTruthy();
    const uploadBtn = screen.getByTestId('upload-subtitle-button') as HTMLButtonElement;
    const fileInput = screen.getByTestId('subtitle-file-input') as HTMLInputElement;
    expect(uploadBtn.disabled).toBe(true);
    expect(fileInput.disabled).toBe(true);
  });

  it('deletes track after user confirms and handles cancellation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');

    // 1. User cancels confirm
    confirmSpy.mockReturnValueOnce(false);
    renderWithClient(
      <VideoSubtitlesSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialVideo={mockVideoWithSubtitles}
      />,
    );

    const deleteViBtn = screen.getByTestId('delete-subtitle-vi');
    fireEvent.click(deleteViBtn);

    expect(confirmSpy).toHaveBeenCalled();
    expect(api.video.DELETE).not.toHaveBeenCalled();

    // 2. User confirms -> DELETE 204 success
    confirmSpy.mockReturnValueOnce(true);
    vi.mocked(api.video.DELETE).mockResolvedValueOnce({
      response: new Response(null, { status: 204 }),
    } as any);

    fireEvent.click(deleteViBtn);

    await waitFor(() => {
      expect(api.video.DELETE).toHaveBeenCalledWith('/v1/videos/{video_id}/subtitles/{lang}', {
        params: {
          path: {
            video_id: '018f1234-5678-7000-8000-000000000001',
            lang: 'vi',
          },
        },
      });
      const alert = screen.getByTestId('subtitles-success-alert');
      expect(alert.textContent).toContain('Xóa phụ đề thành công!');
    });

    confirmSpy.mockRestore();
  });

  it('renders VideoSubtitlesDialog and handles open/close', () => {
    const onClose = vi.fn();
    const { rerender } = renderWithClient(
      <VideoSubtitlesDialog
        isOpen={false}
        videoId="018f1234-5678-7000-8000-000000000001"
        onClose={onClose}
      />,
    );

    expect(screen.queryByTestId('studio-subtitles-section')).toBeNull();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <VideoSubtitlesDialog
          isOpen={true}
          videoId="018f1234-5678-7000-8000-000000000001"
          onClose={onClose}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('studio-subtitles-section')).toBeTruthy();

    const closeBtn = screen.getByTestId('close-subtitles-dialog');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
