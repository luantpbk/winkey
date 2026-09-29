import { api } from '../api-client';
import {
  saveUploadSession,
  getUploadSession,
  deleteUploadSession,
  type UploadSessionRecord,
} from './indexeddb';

export interface UploadProgress {
  videoId: string;
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
  speedMBps: number;
  etaSeconds: number;
  completedParts: number;
  totalParts: number;
  status: 'idle' | 'resuming' | 'presigning' | 'uploading' | 'completing' | 'completed' | 'cancelled' | 'error';
  error?: string;
}

export interface UploadOptions {
  file: File;
  title: string;
  description?: string;
  visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  onProgress?: (progress: UploadProgress) => void;
  maxParallelParts?: number; // default 4
  maxRetries?: number; // default 3
}

export function computeFileFingerprint(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export class MultipartUploader {
  private file: File;
  private title: string;
  private description: string;
  private visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  private onProgress?: (progress: UploadProgress) => void;
  private maxParallelParts: number;
  private maxRetries: number;

  private abortController: AbortController = new AbortController();
  private isCancelled: boolean = false;
  private fingerprint: string;

  private videoId: string = '';
  private partSize: number = 0;
  private partCount: number = 0;
  private completedParts: Map<number, string> = new Map(); // part_number -> etag
  private presignedUrls: Map<number, string> = new Map(); // part_number -> url

  private startTime: number = 0;
  private lastTransferredBytes: number = 0;
  private lastSpeedTime: number = 0;
  private currentSpeedMBps: number = 0;

  constructor(options: UploadOptions) {
    this.file = options.file;
    this.title = options.title;
    this.description = options.description || '';
    this.visibility = options.visibility || 'PUBLIC';
    this.onProgress = options.onProgress;
    this.maxParallelParts = Math.min(options.maxParallelParts || 4, 4);
    this.maxRetries = options.maxRetries || 3;
    this.fingerprint = computeFileFingerprint(this.file);
  }

  private notify(status: UploadProgress['status'], error?: string) {
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
    const remainingBytes = this.file.size - uploadedBytes;
    const etaSeconds =
      this.currentSpeedMBps > 0
        ? Math.ceil(remainingBytes / (this.currentSpeedMBps * 1024 * 1024))
        : 0;

    this.onProgress({
      videoId: this.videoId,
      percent: Math.min(100, Math.round(percent * 10) / 10),
      uploadedBytes,
      totalBytes: this.file.size,
      speedMBps: Math.round(this.currentSpeedMBps * 100) / 100,
      etaSeconds,
      completedParts: this.completedParts.size,
      totalParts: this.partCount,
      status,
      error,
    });
  }

  public async start(): Promise<string> {
    this.isCancelled = false;
    this.abortController = new AbortController();
    this.startTime = Date.now();
    this.lastSpeedTime = Date.now();

    try {
      // 1. Check IndexedDB for existing session (resume after reload)
      this.notify('resuming');
      const existingSession = await getUploadSession(this.fingerprint);

      if (existingSession && existingSession.video_id) {
        this.videoId = existingSession.video_id;
        this.partSize = existingSession.part_size;
        this.partCount = existingSession.part_count;
        for (const p of existingSession.completed_parts) {
          this.completedParts.set(p.part_number, p.etag);
        }
      } else {
        // Create new upload
        const { data, error, response } = await api.upload.POST('/v1/uploads', {
          body: {
            title: this.title,
            description: this.description,
            visibility: this.visibility,
            filename: this.file.name,
            content_type: (this.file.type as any) || 'video/mp4',
            size_bytes: this.file.size,
          },
        });

        if (!response.ok || !data) {
          throw new Error(error?.detail || error?.title || 'Failed to initialize upload');
        }

        this.videoId = data.video_id;
        this.partSize = data.part_size;
        this.partCount = data.part_count;

        await this.persistSession();
      }

      // Check if already completed
      if (this.completedParts.size === this.partCount) {
        await this.completeUpload();
        return this.videoId;
      }

      // 2. Identify missing parts
      const missingPartNumbers: number[] = [];
      for (let i = 1; i <= this.partCount; i++) {
        if (!this.completedParts.has(i)) {
          missingPartNumbers.push(i);
        }
      }

      // 3. Upload parts in parallel (concurrency <= 4) with lazy presigning and retry
      this.notify('uploading');
      await this.uploadPartsWithConcurrency(missingPartNumbers);

      if (this.isCancelled) throw new Error('UPLOAD_CANCELLED');

      // 4. Complete multipart upload
      this.notify('completing');
      await this.completeUpload();

      this.notify('completed');
      await deleteUploadSession(this.fingerprint);
      return this.videoId;
    } catch (err: any) {
      if (this.isCancelled || err?.message === 'UPLOAD_CANCELLED') {
        this.notify('cancelled');
        throw new Error('UPLOAD_CANCELLED');
      }
      this.notify('error', err?.message || 'Upload failed');
      throw err;
    }
  }

  private async fetchPresignedBatch(startPartNumber: number): Promise<void> {
    const batch: number[] = [];
    for (let i = startPartNumber; i <= this.partCount && batch.length < 20; i++) {
      if (!this.completedParts.has(i) && !this.presignedUrls.has(i)) {
        batch.push(i);
      }
    }
    if (batch.length === 0) return;

    const { data, error, response } = await api.upload.POST('/v1/uploads/{video_id}/parts', {
      params: { path: { video_id: this.videoId } },
      body: { part_numbers: batch },
    });

    if (!response.ok || !data) {
      throw new Error(error?.detail || 'Failed to presign upload parts');
    }

    for (const item of data.urls) {
      this.presignedUrls.set(item.part_number, item.url);
    }
  }

  private async getPresignedUrl(partNumber: number): Promise<string> {
    const existing = this.presignedUrls.get(partNumber);
    if (existing) return existing;

    await this.fetchPresignedBatch(partNumber);
    const url = this.presignedUrls.get(partNumber);
    if (!url) {
      throw new Error(`Failed to obtain presigned URL for part ${partNumber}`);
    }
    return url;
  }

  private async uploadPartsWithConcurrency(partsToUpload: number[]): Promise<void> {
    let index = 0;
    const total = partsToUpload.length;

    const worker = async () => {
      while (index < total) {
        if (this.isCancelled) return;
        const currentIdx = index++;
        const partNumber = partsToUpload[currentIdx];
        if (this.isCancelled) return;

        await this.uploadPartWithRetry(partNumber);
        await this.persistSession();
        this.updateSpeed();
        this.notify('uploading');
      }
    };

    const workers: Promise<void>[] = [];
    const concurrency = Math.min(this.maxParallelParts, total);
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
  }

  private async uploadPartWithRetry(partNumber: number): Promise<void> {
    const startByte = (partNumber - 1) * this.partSize;
    const endByte = Math.min(this.file.size, partNumber * this.partSize);
    const chunk = this.file.slice(startByte, endByte);

    let lastError: any = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.isCancelled) return;

      if (attempt > 0) {
        // Exponential backoff: 200ms * 2^attempt + jitter
        const delay = Math.min(5000, 200 * Math.pow(2, attempt) + Math.random() * 100);
        await new Promise((res) => setTimeout(res, delay));
      }

      try {
        const url = await this.getPresignedUrl(partNumber);
        const response = await fetch(url, {
          method: 'PUT',
          body: chunk,
          signal: this.abortController.signal,
        });

        if (response.status === 403) {
          // Presigned URL expired (1h TTL) -> invalidate and refresh
          this.presignedUrls.delete(partNumber);
          throw new Error(`Presigned URL expired for part ${partNumber} (403), refreshed URL and retrying`);
        }

        if (!response.ok) {
          throw new Error(`Part ${partNumber} upload returned status ${response.status}`);
        }

        const rawEtag = response.headers.get('ETag') || response.headers.get('etag');
        if (!rawEtag) {
          throw new Error(`Missing ETag header in response for part ${partNumber}`);
        }

        // Store header value unchanged as per contract
        const etag = rawEtag.trim();
        this.completedParts.set(partNumber, etag);
        return;
      } catch (err: any) {
        if (this.isCancelled) return;
        lastError = err;
      }
    }

    throw lastError || new Error(`Failed to upload part ${partNumber} after ${this.maxRetries} retries`);
  }

  private updateSpeed() {
    const now = Date.now();
    const elapsedSec = (now - this.lastSpeedTime) / 1000;
    if (elapsedSec >= 0.5) {
      let currentUploaded = 0;
      for (const partNum of this.completedParts.keys()) {
        if (partNum === this.partCount) {
          currentUploaded += this.file.size - (this.partCount - 1) * this.partSize;
        } else {
          currentUploaded += this.partSize;
        }
      }
      const deltaBytes = currentUploaded - this.lastTransferredBytes;
      if (deltaBytes > 0) {
        this.currentSpeedMBps = deltaBytes / (1024 * 1024) / elapsedSec;
      }
      this.lastTransferredBytes = currentUploaded;
      this.lastSpeedTime = now;
    }
  }

  private async completeUpload(): Promise<void> {
    const parts = Array.from(this.completedParts.entries())
      .map(([part_number, etag]) => ({ part_number, etag }))
      .sort((a, b) => a.part_number - b.part_number);

    const { error, response } = await api.upload.POST('/v1/uploads/{video_id}/complete', {
      params: { path: { video_id: this.videoId } },
      body: { parts },
    });

    if (!response.ok) {
      throw new Error(error?.detail || 'Failed to complete multipart upload');
    }
  }

  private async persistSession(): Promise<void> {
    const record: UploadSessionRecord = {
      fingerprint: this.fingerprint,
      video_id: this.videoId,
      part_size: this.partSize,
      part_count: this.partCount,
      completed_parts: Array.from(this.completedParts.entries()).map(([part_number, etag]) => ({
        part_number,
        etag,
      })),
      created_at: this.startTime,
    };
    await saveUploadSession(record);
  }

  public async cancel(): Promise<void> {
    this.isCancelled = true;
    this.abortController.abort();

    if (this.videoId) {
      try {
        await api.upload.DELETE('/v1/uploads/{video_id}', {
          params: { path: { video_id: this.videoId } },
        });
      } catch (err) {
        console.warn('Failed to call abort upload API:', err);
      }
    }

    await deleteUploadSession(this.fingerprint);
    this.notify('cancelled');
  }
}
