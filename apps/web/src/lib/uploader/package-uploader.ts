import { api } from '../api-client';
import { MultipartUploader, type UploadProgress } from './uploader';
import { AudioTrackUploader, type AudioTrackUploadProgress } from './audio-track-uploader';
import type { LoadedMediaPackage } from '../media-package/package-loader';

export interface TrackProgressInfo {
  id: string; // lang or trackId
  lang: string;
  label: string;
  kind?: string;
  percent: number;
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'cancelled';
  error?: string;
}

export interface PackageUploadProgress {
  videoId: string;
  overallPercent: number;
  status: 'idle' | 'uploading' | 'completed' | 'cancelled' | 'error';
  error?: string;
  video: {
    percent: number;
    status: UploadProgress['status'];
    speedMBps: number;
    etaSeconds: number;
  };
  audioTracks: TrackProgressInfo[];
  subtitles: TrackProgressInfo[];
}

export interface PackageUploaderOptions {
  mediaPackage: LoadedMediaPackage;
  onProgress?: (progress: PackageUploadProgress) => void;
}

export class PackageUploader {
  private mediaPackage: LoadedMediaPackage;
  private onProgress?: (progress: PackageUploadProgress) => void;

  private videoUploader: MultipartUploader | null = null;
  private audioUploaders: Map<string, AudioTrackUploader> = new Map();
  private isCancelled: boolean = false;
  private videoId: string = '';

  private videoProgress: PackageUploadProgress['video'] = {
    percent: 0,
    status: 'idle',
    speedMBps: 0,
    etaSeconds: 0,
  };

  private audioProgress: Map<string, TrackProgressInfo> = new Map();
  private subtitleProgress: Map<string, TrackProgressInfo> = new Map();

  constructor(options: PackageUploaderOptions) {
    this.mediaPackage = options.mediaPackage;
    this.onProgress = options.onProgress;

    // Initialize audio progress map
    for (const track of this.mediaPackage.audioTracks) {
      const key = `${track.meta.lang}:${track.meta.kind}`;
      this.audioProgress.set(key, {
        id: key,
        lang: track.meta.lang,
        label: track.meta.label,
        kind: track.meta.kind,
        percent: 0,
        status: 'pending',
      });
    }

    // Initialize subtitle progress map
    for (const sub of this.mediaPackage.subtitles) {
      this.subtitleProgress.set(sub.meta.lang, {
        id: sub.meta.lang,
        lang: sub.meta.lang,
        label: sub.meta.label,
        kind: sub.meta.kind,
        percent: 0,
        status: 'pending',
      });
    }
  }

  private notify(overallStatus: PackageUploadProgress['status'], error?: string) {
    if (!this.onProgress) return;

    // Calculate overall percent as weighted average of video and audio tracks
    const audioItems = Array.from(this.audioProgress.values());
    const totalWeights = 1 + audioItems.length;
    let sumPercents = this.videoProgress.percent;
    for (const a of audioItems) {
      sumPercents += a.percent;
    }
    const overallPercent =
      totalWeights > 0 ? Math.round((sumPercents / totalWeights) * 10) / 10 : 0;

    this.onProgress({
      videoId: this.videoId,
      overallPercent: Math.min(100, overallPercent),
      status: overallStatus,
      error,
      video: { ...this.videoProgress },
      audioTracks: Array.from(this.audioProgress.values()).map((t) => ({ ...t })),
      subtitles: Array.from(this.subtitleProgress.values()).map((s) => ({ ...s })),
    });
  }

  public async start(): Promise<string> {
    this.isCancelled = false;
    this.notify('uploading');

    let videoPromiseResolve: (vid: string) => void;
    let videoPromiseReject: (err: any) => void;
    const videoUploadFinished = new Promise<string>((resolve, reject) => {
      videoPromiseResolve = resolve;
      videoPromiseReject = reject;
    });

    let secondaryUploadsPromise: Promise<void> | null = null;

    // Create Video Uploader
    this.videoUploader = new MultipartUploader({
      file: this.mediaPackage.videoFile,
      title: this.mediaPackage.manifest.title,
      description: this.mediaPackage.manifest.description || '',
      visibility: this.mediaPackage.manifest.visibility || 'PUBLIC',
      onProgress: (p) => {
        this.videoProgress = {
          percent: p.percent,
          status: p.status,
          speedMBps: p.speedMBps,
          etaSeconds: p.etaSeconds,
        };
        this.notify('uploading');
      },
      onVideoIdCreated: (vid) => {
        if (!this.videoId) {
          this.videoId = vid;
          // Launch audio tracks and subtitles as soon as videoId is established
          secondaryUploadsPromise = this.startSecondaryUploads(vid);
        }
      },
    });

    // Start video upload
    this.videoUploader
      .start()
      .then((vid) => {
        videoPromiseResolve(vid);
      })
      .catch((err) => {
        videoPromiseReject(err);
      });

    try {
      const vid = await videoUploadFinished;
      if (secondaryUploadsPromise) {
        await secondaryUploadsPromise;
      }
      this.notify('completed');
      return vid;
    } catch (err: any) {
      if (this.isCancelled) {
        this.notify('cancelled');
        throw new Error('UPLOAD_CANCELLED');
      }
      this.notify('error', err?.message || 'Package upload failed');
      throw err;
    }
  }

  private async startSecondaryUploads(videoId: string): Promise<void> {
    // 1. Subtitles uploads in parallel
    const subPromises = this.mediaPackage.subtitles.map(async (sub) => {
      const key = sub.meta.lang;
      const subItem = this.subtitleProgress.get(key);
      if (subItem) {
        subItem.status = 'uploading';
        subItem.percent = 50;
      }

      try {
        const { response, error } = await api.video.PUT('/v1/videos/{video_id}/subtitles/{lang}', {
          params: { path: { video_id: videoId, lang: sub.meta.lang } },
          body: {
            label: sub.meta.label,
            content: sub.content,
            kind: sub.meta.kind,
            is_default: sub.meta.default,
          },
        });

        if (!response.ok) {
          const errDetail =
            (error as any)?.detail || (error as any)?.code || 'Failed to upload subtitle';
          if (subItem) {
            subItem.status = 'error';
            subItem.error = errDetail;
          }
          throw new Error(errDetail);
        }

        if (subItem) {
          subItem.status = 'completed';
          subItem.percent = 100;
        }
      } catch (err: any) {
        if (subItem) {
          subItem.status = 'error';
          subItem.error = err?.message || 'Subtitle upload error';
        }
        throw err;
      }
    });

    // 2. Audio tracks uploaded one at a time (at most video + 1 audio track open)
    const audioSeqPromise = (async () => {
      for (const track of this.mediaPackage.audioTracks) {
        if (this.isCancelled) break;
        await this.uploadAudioTrackWithRetry(videoId, track);
      }
    })();

    await Promise.all([...subPromises, audioSeqPromise]);
  }

  private async uploadAudioTrackWithRetry(
    videoId: string,
    track: LoadedMediaPackage['audioTracks'][number],
    maxRetries = 10,
  ): Promise<void> {
    const key = `${track.meta.lang}:${track.meta.kind}`;
    let attempt = 0;

    while (attempt < maxRetries) {
      if (this.isCancelled) return;
      attempt++;

      const uploader = new AudioTrackUploader({
        videoId,
        file: track.file,
        lang: track.meta.lang,
        label: track.meta.label,
        kind: track.meta.kind,
        isDefault: track.meta.default,
        onProgress: (p: AudioTrackUploadProgress) => {
          const item = this.audioProgress.get(key);
          if (item) {
            item.percent = p.percent;
            item.status =
              p.status === 'completed'
                ? 'completed'
                : p.status === 'error'
                  ? 'error'
                  : p.status === 'cancelled'
                    ? 'cancelled'
                    : 'uploading';
            item.error = p.error;
            this.notify('uploading');
          }
        },
      });

      this.audioUploaders.set(key, uploader);

      try {
        await uploader.start();
        const item = this.audioProgress.get(key);
        if (item) {
          item.percent = 100;
          item.status = 'completed';
          item.error = undefined;
          this.notify('uploading');
        }
        return;
      } catch (err: any) {
        if (this.isCancelled) return;

        const is429 =
          err?.code === 'UPLOAD_QUOTA_EXCEEDED' ||
          err?.status === 429 ||
          err?.retryAfter != null ||
          err?.message?.includes('UPLOAD_QUOTA_EXCEEDED') ||
          err?.message?.includes('giới hạn tải lên');

        if (is429 && attempt < maxRetries) {
          const retrySeconds = err?.retryAfter ?? err?.retryAfterSeconds ?? 2;
          const item = this.audioProgress.get(key);
          if (item) {
            item.status = 'uploading';
            item.error = 'waiting for a free slot';
            this.notify('uploading');
          }
          await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
          continue;
        }

        const item = this.audioProgress.get(key);
        if (item) {
          item.status = 'error';
          item.error = err?.message || 'Audio upload error';
          this.notify('uploading');
        }
        throw err;
      }
    }
  }

  public async cancel(): Promise<void> {
    this.isCancelled = true;
    if (this.videoUploader) {
      await this.videoUploader.cancel();
    }
    for (const uploader of this.audioUploaders.values()) {
      await uploader.cancel();
    }
    this.notify('cancelled');
  }
}
