import { api } from '../api-client';
import type { AudioTrack, AudioTrackKind } from '@winkey/api-client';

export type AllowedAudioContentType =
  | 'audio/wav'
  | 'audio/x-wav'
  | 'audio/flac'
  | 'audio/mp4'
  | 'audio/x-m4a'
  | 'audio/aac'
  | 'audio/ogg'
  | 'audio/webm';

export function inferAudioContentType(file: File): AllowedAudioContentType {
  const allowed: AllowedAudioContentType[] = [
    'audio/wav',
    'audio/x-wav',
    'audio/flac',
    'audio/mp4',
    'audio/x-m4a',
    'audio/aac',
    'audio/ogg',
    'audio/webm',
  ];

  if (allowed.includes(file.type as AllowedAudioContentType)) {
    return file.type as AllowedAudioContentType;
  }

  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'm4a':
      return 'audio/x-m4a';
    case 'aac':
      return 'audio/aac';
    case 'ogg':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    case 'mp4':
      return 'audio/mp4';
    default:
      return 'audio/x-m4a';
  }
}

export interface AudioTrackUploadProgress {
  trackId: string;
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
  status: 'idle' | 'presigning' | 'uploading' | 'completing' | 'completed' | 'cancelled' | 'error';
  error?: string;
  retryAfterSeconds?: number;
}

export interface AudioTrackUploadOptions {
  videoId: string;
  file: File;
  lang: string;
  label: string;
  kind: AudioTrackKind;
  isDefault?: boolean;
  onProgress?: (progress: AudioTrackUploadProgress) => void;
  maxParallelParts?: number;
}

export class AudioTrackUploader {
  private videoId: string;
  private file: File;
  private lang: string;
  private label: string;
  private kind: AudioTrackKind;
  private isDefault?: boolean;
  private onProgress?: (progress: AudioTrackUploadProgress) => void;
  private maxParallelParts: number;

  private trackId: string = '';
  private partSize: number = 0;
  private partCount: number = 0;
  private completedParts: Map<number, string> = new Map();
  private abortController: AbortController = new AbortController();
  private isCancelled: boolean = false;

  constructor(options: AudioTrackUploadOptions) {
    this.videoId = options.videoId;
    this.file = options.file;
    this.lang = options.lang;
    this.label = options.label;
    this.kind = options.kind;
    this.isDefault = options.isDefault;
    this.onProgress = options.onProgress;
    this.maxParallelParts = Math.min(options.maxParallelParts || 4, 4);
  }

  private notify(
    status: AudioTrackUploadProgress['status'],
    error?: string,
    retryAfterSeconds?: number,
  ) {
    if (!this.onProgress) return;

    let uploadedBytes = 0;
    for (const partNum of this.completedParts.keys()) {
      if (partNum === this.partCount) {
        uploadedBytes += this.file.size - (this.partCount - 1) * this.partSize;
      } else {
        uploadedBytes += this.partSize;
      }
    }
    if (uploadedBytes > this.file.size) uploadedBytes = this.file.size;

    const percent = this.file.size > 0 ? (uploadedBytes / this.file.size) * 100 : 0;

    this.onProgress({
      trackId: this.trackId,
      percent: Math.min(100, Math.round(percent * 10) / 10),
      uploadedBytes,
      totalBytes: this.file.size,
      status,
      error,
      retryAfterSeconds,
    });
  }

  public async start(): Promise<AudioTrack> {
    this.isCancelled = false;
    this.abortController = new AbortController();

    try {
      this.notify('presigning');

      // 1. Initialize audio track upload
      const contentType = inferAudioContentType(this.file);
      const { data, error, response } = await api.upload.POST(
        '/v1/uploads/{video_id}/audio-tracks',
        {
          params: { path: { video_id: this.videoId } },
          body: {
            lang: this.lang,
            label: this.label,
            kind: this.kind,
            is_default: this.isDefault,
            filename: this.file.name,
            content_type: contentType,
            size_bytes: this.file.size,
          },
        },
      );

      if (!response.ok || !data) {
        if (response.status === 429) {
          const retryHeader = response.headers.get('Retry-After');
          const seconds = retryHeader ? parseInt(retryHeader, 10) : 60;
          const msg = `Vượt quá giới hạn tải lên. Vui lòng thử lại sau ${seconds} giây.`;
          this.notify('error', msg, seconds);
          const err = new Error(msg);
          (err as unknown as { code?: string; retryAfter?: number }).code = 'UPLOAD_QUOTA_EXCEEDED';
          (err as unknown as { retryAfter?: number }).retryAfter = seconds;
          throw err;
        }

        const errData = error as { code?: string; detail?: string; title?: string } | undefined;
        let msg = errData?.detail || errData?.title || 'Không thể khởi tạo tải lên track âm thanh';
        if (errData?.code === 'AUDIO_TRACK_EXISTS') {
          msg = `Track âm thanh cho ngôn ngữ "${this.lang}" và thể loại "${this.kind}" đã tồn tại.`;
        } else if (errData?.code === 'TOO_MANY_AUDIO_TRACKS') {
          msg = 'Đã đạt giới hạn tối đa 8 track âm thanh cho video này.';
        }

        this.notify('error', msg);
        const err = new Error(msg);
        if (errData?.code) {
          (err as unknown as { code?: string }).code = errData.code;
        }
        throw err;
      }

      this.trackId = data.track_id;
      this.partSize = data.part_size;
      this.partCount = data.part_count;

      // 2. Presign all parts
      const partNumbers = Array.from({ length: this.partCount }, (_, i) => i + 1);
      const {
        data: partsData,
        error: partsErr,
        response: partsRes,
      } = await api.upload.POST('/v1/uploads/{video_id}/audio-tracks/{track_id}/parts', {
        params: { path: { video_id: this.videoId, track_id: this.trackId } },
        body: { part_numbers: partNumbers },
      });

      if (!partsRes.ok || !partsData) {
        const msg = partsErr?.detail || partsErr?.title || 'Không thể lấy URL tải lên cho các phần';
        this.notify('error', msg);
        throw new Error(msg);
      }

      const presignedMap = new Map<number, string>();
      const list = partsData.urls || (partsData as any).parts || [];
      for (const p of list) {
        presignedMap.set(p.part_number, p.url);
      }

      // 3. Upload parts in parallel (pool size maxParallelParts)
      this.notify('uploading');
      const queue = [...partNumbers];

      const worker = async () => {
        while (queue.length > 0) {
          if (this.isCancelled) return;
          const partNum = queue.shift()!;
          const url = presignedMap.get(partNum);
          if (!url) throw new Error(`Missing URL for part ${partNum}`);

          const startByte = (partNum - 1) * this.partSize;
          const endByte = Math.min(this.file.size, startByte + this.partSize);
          const chunk = this.file.slice(startByte, endByte);

          const putRes = await fetch(url, {
            method: 'PUT',
            body: chunk,
            signal: this.abortController.signal,
          });

          if (!putRes.ok) {
            throw new Error(`Tải lên phần ${partNum} thất bại: HTTP ${putRes.status}`);
          }

          let etag = putRes.headers.get('etag') || putRes.headers.get('ETag') || '';
          etag = etag.replace(/^"|"$/g, '').trim();
          this.completedParts.set(partNum, etag);
          this.notify('uploading');
        }
      };

      const workers = Array.from(
        { length: Math.min(this.maxParallelParts, partNumbers.length) },
        () => worker(),
      );
      await Promise.all(workers);

      if (this.isCancelled) {
        this.notify('cancelled');
        throw new Error('Upload cancelled');
      }

      // 4. Complete upload
      this.notify('completing');
      const partsPayload = Array.from(this.completedParts.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([part_number, etag]) => ({ part_number, etag }));

      const {
        data: completeData,
        error: completeErr,
        response: completeRes,
      } = await api.upload.POST('/v1/uploads/{video_id}/audio-tracks/{track_id}/complete', {
        params: { path: { video_id: this.videoId, track_id: this.trackId } },
        body: { parts: partsPayload },
      });

      if (!completeRes.ok || !completeData) {
        const msg =
          completeErr?.detail || completeErr?.title || 'Không thể hoàn tất tải lên track âm thanh';
        this.notify('error', msg);
        throw new Error(msg);
      }

      this.notify('completed');
      return completeData as AudioTrack;
    } catch (err: unknown) {
      if (this.isCancelled) {
        this.notify('cancelled');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const retryAfter = (err as unknown as { retryAfter?: number })?.retryAfter;
        this.notify('error', msg, retryAfter);
      }
      throw err;
    }
  }

  public async cancel(): Promise<void> {
    this.isCancelled = true;
    this.abortController.abort();
    if (this.trackId) {
      try {
        await api.upload.DELETE('/v1/uploads/{video_id}/audio-tracks/{track_id}', {
          params: { path: { video_id: this.videoId, track_id: this.trackId } },
        });
      } catch (err) {
        console.warn('[AudioTrackUploader] Failed to abort on server:', err);
      }
    }
    this.notify('cancelled');
  }
}
