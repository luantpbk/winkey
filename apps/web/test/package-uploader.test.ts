import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PackageUploader } from '../src/lib/uploader/package-uploader';
import { api } from '../src/lib/api-client';
import type { LoadedMediaPackage } from '../src/lib/media-package/package-loader';

// Mock api
vi.mock('../src/lib/api-client', () => ({
  api: {
    video: {
      PUT: vi.fn(),
    },
    upload: {
      POST: vi.fn(),
      DELETE: vi.fn(),
    },
  },
}));

// Mock MultipartUploader
let lastVideoUploaderOptions: any = null;
vi.mock('../src/lib/uploader/uploader', () => ({
  MultipartUploader: class MockMultipartUploader {
    private options: any;
    constructor(options: any) {
      this.options = options;
      lastVideoUploaderOptions = options;
    }
    async start() {
      // Simulate onVideoIdCreated immediate callback
      this.options.onVideoIdCreated?.('vid-test-123');
      this.options.onProgress?.({
        videoId: 'vid-test-123',
        percent: 100,
        uploadedBytes: 1000,
        totalBytes: 1000,
        speedMBps: 10,
        etaSeconds: 0,
        completedParts: 1,
        totalParts: 1,
        status: 'completed',
      });
      return 'vid-test-123';
    }
    async cancel() {}
  },
}));

// Mock AudioTrackUploader
let createdAudioUploaders: any[] = [];
vi.mock('../src/lib/uploader/audio-track-uploader', () => ({
  AudioTrackUploader: class MockAudioTrackUploader {
    private options: any;
    constructor(options: any) {
      this.options = options;
      createdAudioUploaders.push(options);
    }
    async start() {
      this.options.onProgress?.({
        trackId: 'track-test',
        percent: 100,
        uploadedBytes: 500,
        totalBytes: 500,
        status: 'completed',
      });
      return { id: 'track-test' };
    }
    async cancel() {}
  },
}));

describe('PackageUploader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdAudioUploaders = [];
    lastVideoUploaderOptions = null;
  });

  const mockLoadedPackage: LoadedMediaPackage = {
    manifest: {
      schema: 'winkey.media-package/v1',
      title: 'Action Movie Package',
      description: 'With dub and subtitles',
      visibility: 'PUBLIC',
      video: { file: 'main.mp4' },
      audio_tracks: [
        {
          file: 'audio/vi.wav',
          lang: 'vi',
          kind: 'dub',
          label: 'Lồng tiếng Việt',
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
    videoFile: new File(['video data'], 'main.mp4', { type: 'video/mp4' }),
    audioTracks: [
      {
        meta: {
          file: 'audio/vi.wav',
          lang: 'vi',
          kind: 'dub',
          label: 'Lồng tiếng Việt',
          default: true,
        },
        file: new File(['audio data'], 'vi.wav', { type: 'audio/wav' }),
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
        file: new File(['WEBVTT'], 'en.vtt', { type: 'text/vtt' }),
        content: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello',
      },
    ],
    allFilePaths: ['manifest.json', 'main.mp4', 'audio/vi.wav', 'subtitles/en.vtt'],
  };

  it('orchestrates video upload and triggers audio & subtitle uploads as soon as videoId is created', async () => {
    vi.mocked(api.video.PUT).mockResolvedValue({
      response: new Response(null, { status: 201 }),
    } as any);

    const progressReports: any[] = [];
    const uploader = new PackageUploader({
      mediaPackage: mockLoadedPackage,
      onProgress: (p) => progressReports.push(p),
    });

    const videoId = await uploader.start();

    expect(videoId).toBe('vid-test-123');

    // Video uploader created with manifest metadata
    expect(lastVideoUploaderOptions.title).toBe('Action Movie Package');
    expect(lastVideoUploaderOptions.description).toBe('With dub and subtitles');
    expect(lastVideoUploaderOptions.visibility).toBe('PUBLIC');

    // Audio uploader triggered with videoId
    expect(createdAudioUploaders).toHaveLength(1);
    expect(createdAudioUploaders[0].videoId).toBe('vid-test-123');
    expect(createdAudioUploaders[0].lang).toBe('vi');
    expect(createdAudioUploaders[0].kind).toBe('dub');
    expect(createdAudioUploaders[0].isDefault).toBe(true);

    // Subtitle upload called with videoId and kind='captions'
    expect(api.video.PUT).toHaveBeenCalledWith('/v1/videos/{video_id}/subtitles/{lang}', {
      params: { path: { video_id: 'vid-test-123', lang: 'en' } },
      body: {
        label: 'English CC',
        content: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello',
        kind: 'captions',
      },
    });

    const finalReport = progressReports[progressReports.length - 1];
    expect(finalReport.status).toBe('completed');
    expect(finalReport.overallPercent).toBe(100);
  });
});
