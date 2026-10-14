import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AudioTrackUploader,
  inferAudioContentType,
} from '../src/lib/uploader/audio-track-uploader';
import { api } from '../src/lib/api-client';

describe('MUX1: AudioTrackUploader', () => {
  const dummyFile = new File(['a'.repeat(1024 * 1024 * 10)], 'test-audio.m4a', {
    type: 'audio/x-m4a',
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('infers audio content-type from file extension and mime', () => {
    expect(inferAudioContentType(new File([], 'song.wav', { type: 'audio/wav' }))).toBe(
      'audio/wav',
    );
    expect(inferAudioContentType(new File([], 'song.flac'))).toBe('audio/flac');
    expect(inferAudioContentType(new File([], 'song.m4a'))).toBe('audio/x-m4a');
    expect(inferAudioContentType(new File([], 'song.aac'))).toBe('audio/aac');
    expect(inferAudioContentType(new File([], 'song.ogg'))).toBe('audio/ogg');
  });

  it('uploads audio track via multipart flow successfully', async () => {
    const postSpy = vi.spyOn(api.upload, 'POST');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // 1. Mock createAudioTrackUpload response
    postSpy.mockImplementationOnce(async (url: string) => {
      if (url === '/v1/uploads/{video_id}/audio-tracks') {
        return {
          data: {
            track_id: '018f3a2b-audio-1111-2222-333344445555',
            part_size: 5 * 1024 * 1024,
            part_count: 2,
          },
          response: new Response(null, { status: 201 }),
          error: undefined,
        } as any;
      }
      return {} as any;
    });

    // 2. Mock presignAudioTrackParts response
    postSpy.mockImplementationOnce(async (url: string) => {
      if (url === '/v1/uploads/{video_id}/audio-tracks/{track_id}/parts') {
        return {
          data: {
            urls: [
              { part_number: 1, url: 'https://s3.local/part1' },
              { part_number: 2, url: 'https://s3.local/part2' },
            ],
            parts: [
              { part_number: 1, url: 'https://s3.local/part1' },
              { part_number: 2, url: 'https://s3.local/part2' },
            ],
          },
          response: new Response(null, { status: 200 }),
          error: undefined,
        } as any;
      }
      return {} as any;
    });

    // 3. Mock S3 PUT responses with ETag
    fetchSpy.mockImplementation(async () => {
      const headers = new Headers();
      headers.set('ETag', '"mock-etag"');
      return new Response(null, { status: 200, headers });
    });

    // 4. Mock completeAudioTrackUpload response
    postSpy.mockImplementationOnce(async (url: string) => {
      if (url === '/v1/uploads/{video_id}/audio-tracks/{track_id}/complete') {
        return {
          data: {
            id: '018f3a2b-audio-1111-2222-333344445555',
            lang: 'vi',
            label: 'Thuyết minh',
            kind: 'voiceover',
            is_default: true,
            status: 'UPLOADED',
            error: null,
            updated_at: '2026-10-14T00:00:00Z',
          },
          response: new Response(null, { status: 202 }),
          error: undefined,
        } as any;
      }
      return {} as any;
    });

    const progressUpdates: any[] = [];
    const uploader = new AudioTrackUploader({
      videoId: 'video-123',
      file: dummyFile,
      lang: 'vi',
      label: 'Thuyết minh',
      kind: 'voiceover',
      isDefault: true,
      onProgress: (p) => progressUpdates.push(p),
    });

    const track = await uploader.start();

    expect(track.id).toBe('018f3a2b-audio-1111-2222-333344445555');
    expect(track.status).toBe('UPLOADED');
    expect(progressUpdates.some((p) => p.status === 'completed')).toBe(true);

    postSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('handles 409 AUDIO_TRACK_EXISTS error clearly', async () => {
    const postSpy = vi.spyOn(api.upload, 'POST').mockResolvedValueOnce({
      data: undefined,
      response: new Response(null, { status: 409 }),
      error: { code: 'AUDIO_TRACK_EXISTS', detail: 'Audio track exists' },
    } as any);

    const uploader = new AudioTrackUploader({
      videoId: 'video-123',
      file: dummyFile,
      lang: 'vi',
      label: 'Thuyết minh',
      kind: 'voiceover',
    });

    await expect(uploader.start()).rejects.toThrow('đã tồn tại');
    postSpy.mockRestore();
  });

  it('handles 409 TOO_MANY_AUDIO_TRACKS error clearly', async () => {
    const postSpy = vi.spyOn(api.upload, 'POST').mockResolvedValueOnce({
      data: undefined,
      response: new Response(null, { status: 409 }),
      error: { code: 'TOO_MANY_AUDIO_TRACKS', detail: 'Max 8 audio tracks' },
    } as any);

    const uploader = new AudioTrackUploader({
      videoId: 'video-123',
      file: dummyFile,
      lang: 'en',
      label: 'English',
      kind: 'dub',
    });

    await expect(uploader.start()).rejects.toThrow('tối đa 8 track âm thanh');
    postSpy.mockRestore();
  });

  it('handles 429 UPLOAD_QUOTA_EXCEEDED with Retry-After header', async () => {
    const headers = new Headers();
    headers.set('Retry-After', '45');
    const postSpy = vi.spyOn(api.upload, 'POST').mockResolvedValueOnce({
      data: undefined,
      response: new Response(null, { status: 429, headers }),
      error: { code: 'UPLOAD_QUOTA_EXCEEDED', detail: 'Quota exceeded' },
    } as any);

    let reportedProgress: any = null;
    const uploader = new AudioTrackUploader({
      videoId: 'video-123',
      file: dummyFile,
      lang: 'en',
      label: 'English',
      kind: 'dub',
      onProgress: (p) => {
        reportedProgress = p;
      },
    });

    await expect(uploader.start()).rejects.toThrow('45 giây');
    expect(reportedProgress?.retryAfterSeconds).toBe(45);
    postSpy.mockRestore();
  });

  it('cancels upload and calls abortAudioTrackUpload', async () => {
    const deleteSpy = vi.spyOn(api.upload, 'DELETE').mockResolvedValueOnce({
      response: new Response(null, { status: 204 }),
    } as any);

    const uploader = new AudioTrackUploader({
      videoId: 'video-123',
      file: dummyFile,
      lang: 'en',
      label: 'English',
      kind: 'dub',
    });

    // Set private trackId to test abort call
    (uploader as any).trackId = 'track-123';
    await uploader.cancel();

    expect(deleteSpy).toHaveBeenCalledWith(
      '/v1/uploads/{video_id}/audio-tracks/{track_id}',
      expect.objectContaining({
        params: { path: { video_id: 'video-123', track_id: 'track-123' } },
      }),
    );

    deleteSpy.mockRestore();
  });
});
