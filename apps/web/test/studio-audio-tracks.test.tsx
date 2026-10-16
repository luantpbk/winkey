import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VideoAudioTracksSection } from '../src/components/studio/video-audio-tracks-section';
import { api } from '../src/lib/api-client';
import type { AudioTrack } from '@winkey/api-client';
import viMessages from '../messages/vi.json';
import enMessages from '../messages/en.json';

let activeLocale = 'vi';
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

vi.mock('../src/lib/api-client', () => ({
  api: {
    video: {
      GET: vi.fn(),
      PATCH: vi.fn(),
      DELETE: vi.fn(),
    },
    upload: {
      POST: vi.fn(),
      DELETE: vi.fn(),
    },
  },
}));

const mockTracks: AudioTrack[] = [
  {
    id: '018f0001-0000-7000-8000-000000000001',
    lang: 'vi',
    label: 'Tiếng Việt (Lồng tiếng)',
    kind: 'dub',
    is_default: true,
    status: 'READY',
    error: null,
    updated_at: '2026-10-14T10:00:00Z',
  },
  {
    id: '018f0001-0000-7000-8000-000000000002',
    lang: 'en',
    label: 'English Commentary',
    kind: 'commentary',
    is_default: false,
    status: 'PROCESSING',
    error: null,
    updated_at: '2026-10-14T10:05:00Z',
  },
  {
    id: '018f0001-0000-7000-8000-000000000003',
    lang: 'ja',
    label: 'Japanese Voiceover',
    kind: 'voiceover',
    is_default: false,
    status: 'FAILED',
    error: 'AUDIO_DURATION_MISMATCH',
    updated_at: '2026-10-14T10:10:00Z',
  },
  {
    id: '018f0001-0000-7000-8000-000000000004',
    lang: 'ko',
    label: 'Korean Dub',
    kind: 'dub',
    is_default: false,
    status: 'UPLOADING',
    error: null,
    updated_at: '2026-10-14T10:15:00Z',
  },
];

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

describe('Studio VideoAudioTracksSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeLocale = 'vi';
    vi.mocked(api.video.GET).mockResolvedValue({
      data: { items: mockTracks },
      response: new Response(null, { status: 200 }),
    } as any);
  });

  it('renders audio track list with status badges, kind badges, and error reasons', async () => {
    vi.mocked(api.video.GET).mockResolvedValue({
      data: mockTracks,
      response: new Response(null, { status: 200 }),
    } as any);

    renderWithClient(
      <VideoAudioTracksSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialTracks={mockTracks}
      />,
    );

    expect(screen.getByTestId('studio-audio-tracks-section')).toBeTruthy();
    expect(screen.getByText('Danh sách track âm thanh (4/8)')).toBeTruthy();

    // Track 1 (vi, default, READY)
    expect(screen.getByTestId('audio-track-row-018f0001-0000-7000-8000-000000000001')).toBeTruthy();
    expect(
      screen.getByTestId('audio-track-default-badge-018f0001-0000-7000-8000-000000000001'),
    ).toBeTruthy();
    expect(
      screen.getByTestId('audio-track-status-018f0001-0000-7000-8000-000000000001').textContent,
    ).toContain('Sẵn sàng');

    // Track 2 (en, PROCESSING)
    expect(
      screen.getByTestId('audio-track-status-018f0001-0000-7000-8000-000000000002').textContent,
    ).toContain('Đang xử lý');

    // Track 3 (ja, FAILED, AUDIO_DURATION_MISMATCH)
    expect(
      screen.getByTestId('audio-track-status-018f0001-0000-7000-8000-000000000003').textContent,
    ).toContain('Lỗi xử lý');
    expect(
      screen.getByTestId('audio-track-error-018f0001-0000-7000-8000-000000000003').textContent,
    ).toContain('Lệch thời lượng (> 100ms)');

    // Track 4 (ko, UPLOADING)
    expect(
      screen.getByTestId('audio-track-status-018f0001-0000-7000-8000-000000000004').textContent,
    ).toContain('Đang tải lên');
  });

  it('makes a track default via updateAudioTrack PATCH', async () => {
    vi.mocked(api.video.PATCH).mockResolvedValue({
      data: { ...mockTracks[1], is_default: true },
      response: new Response(null, { status: 200 }),
    } as any);

    renderWithClient(
      <VideoAudioTracksSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialTracks={mockTracks}
      />,
    );

    const makeDefaultBtn = screen.getByTestId(
      'make-default-track-018f0001-0000-7000-8000-000000000002',
    );
    fireEvent.click(makeDefaultBtn);

    await waitFor(() => {
      expect(api.video.PATCH).toHaveBeenCalledWith(
        '/v1/videos/{video_id}/audio-tracks/{track_id}',
        {
          params: {
            path: {
              video_id: '018f1234-5678-7000-8000-000000000001',
              track_id: '018f0001-0000-7000-8000-000000000002',
            },
          },
          body: { is_default: true },
        },
      );
      expect(screen.getByTestId('audio-tracks-success-alert')).toBeTruthy();
    });
  });

  it('renames a track via updateAudioTrack PATCH', async () => {
    vi.mocked(api.video.PATCH).mockResolvedValue({
      data: { ...mockTracks[0], label: 'Tiếng Việt Bản Mới' },
      response: new Response(null, { status: 200 }),
    } as any);

    renderWithClient(
      <VideoAudioTracksSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialTracks={mockTracks}
      />,
    );

    const renameBtn = screen.getByTestId('rename-track-018f0001-0000-7000-8000-000000000001');
    fireEvent.click(renameBtn);

    const renameInput = screen.getByTestId('rename-input-018f0001-0000-7000-8000-000000000001');
    fireEvent.change(renameInput, { target: { value: 'Tiếng Việt Bản Mới' } });

    const saveRenameBtn = screen.getByTestId('save-rename-018f0001-0000-7000-8000-000000000001');
    fireEvent.click(saveRenameBtn);

    await waitFor(() => {
      expect(api.video.PATCH).toHaveBeenCalledWith(
        '/v1/videos/{video_id}/audio-tracks/{track_id}',
        {
          params: {
            path: {
              video_id: '018f1234-5678-7000-8000-000000000001',
              track_id: '018f0001-0000-7000-8000-000000000001',
            },
          },
          body: { label: 'Tiếng Việt Bản Mới' },
        },
      );
    });
  });

  it('deletes a normal track using api.video.DELETE and aborts an UPLOADING track using api.upload.DELETE', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    vi.mocked(api.video.DELETE).mockResolvedValue({
      response: new Response(null, { status: 204 }),
    } as any);

    vi.mocked(api.upload.DELETE).mockResolvedValue({
      response: new Response(null, { status: 204 }),
    } as any);

    renderWithClient(
      <VideoAudioTracksSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialTracks={mockTracks}
      />,
    );

    // 1. Delete track 1 (READY -> api.video.DELETE)
    const deleteBtn1 = screen.getByTestId('delete-track-018f0001-0000-7000-8000-000000000001');
    fireEvent.click(deleteBtn1);

    await waitFor(() => {
      expect(api.video.DELETE).toHaveBeenCalledWith(
        '/v1/videos/{video_id}/audio-tracks/{track_id}',
        {
          params: {
            path: {
              video_id: '018f1234-5678-7000-8000-000000000001',
              track_id: '018f0001-0000-7000-8000-000000000001',
            },
          },
        },
      );
    });

    // 2. Delete track 4 (UPLOADING -> api.upload.DELETE)
    const deleteBtn4 = screen.getByTestId('delete-track-018f0001-0000-7000-8000-000000000004');
    fireEvent.click(deleteBtn4);

    await waitFor(() => {
      expect(api.upload.DELETE).toHaveBeenCalledWith(
        '/v1/uploads/{video_id}/audio-tracks/{track_id}',
        {
          params: {
            path: {
              video_id: '018f1234-5678-7000-8000-000000000001',
              track_id: '018f0001-0000-7000-8000-000000000004',
            },
          },
        },
      );
    });
  });

  it('validates BCP-47 tag and duplicate (lang, kind) before upload', async () => {
    renderWithClient(
      <VideoAudioTracksSection
        videoId="018f1234-5678-7000-8000-000000000001"
        initialTracks={mockTracks}
      />,
    );

    const submitBtn = screen.getByTestId('upload-audio-track-button');
    fireEvent.click(submitBtn);

    // No file selected error
    await waitFor(() => {
      expect(screen.getByTestId('audio-tracks-error-alert').textContent).toContain(
        'Vui lòng chọn tập tin âm thanh',
      );
    });

    // Provide file
    const fileInput = screen.getByTestId('audio-file-input');
    const dummyFile = new File(['dummy audio content'], 'audio.wav', { type: 'audio/wav' });
    fireEvent.change(fileInput, { target: { files: [dummyFile] } });

    // Choose custom invalid lang
    const langSelect = screen.getByTestId('audio-lang-select');
    fireEvent.change(langSelect, { target: { value: 'custom' } });

    const customInput = screen.getByTestId('audio-custom-lang-input');
    fireEvent.change(customInput, { target: { value: 'invalid_lang_tag!' } });

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByTestId('audio-tracks-error-alert').textContent).toContain(
        'Mã ngôn ngữ không đúng định dạng BCP-47',
      );
    });

    // Choose existing (vi, dub)
    fireEvent.change(langSelect, { target: { value: 'vi' } });
    const kindSelect = screen.getByTestId('audio-kind-select');
    fireEvent.change(kindSelect, { target: { value: 'dub' } });

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByTestId('audio-tracks-error-alert').textContent).toContain(
        'Track âm thanh với ngôn ngữ và phân loại này đã tồn tại',
      );
    });
  });
});
