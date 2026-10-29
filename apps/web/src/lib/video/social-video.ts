import { api } from '../api-client';

export const MAX_SOCIAL_VIDEO_BYTES = 300 * 1024 * 1024; // 300 MiB (314,572,800 bytes)
export const MAX_SOCIAL_VIDEO_SECONDS = 180; // 3 minutes

export interface SocialVideoMetadata {
  duration: number; // in seconds
  width: number;
  height: number;
}

/**
 * Validates duration and size of a social video file in the browser before upload (SOC-2b, ADR-049).
 * Refuses > 180s or > 300 MiB with clear messages.
 */
export async function validateSocialVideoFile(file: File): Promise<SocialVideoMetadata> {
  if (file.size > MAX_SOCIAL_VIDEO_BYTES) {
    throw new Error('Video vượt quá giới hạn 300 MiB (tối đa 300 MiB).');
  }

  // If in browser environment with HTMLVideoElement support
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      const objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;

      let settled = false;

      const cleanup = () => {
        settled = true;
        URL.revokeObjectURL(objectUrl);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };

      const onLoaded = () => {
        if (settled) return;
        const duration = video.duration;
        const width = video.videoWidth || 720;
        const height = video.videoHeight || 1280;
        cleanup();

        if (Number.isFinite(duration) && duration > MAX_SOCIAL_VIDEO_SECONDS) {
          reject(new Error('Thời lượng video vượt quá 3 phút (tối đa 180 giây).'));
          return;
        }

        resolve({
          duration: Number.isFinite(duration) ? duration : 0,
          width,
          height,
        });
      };

      const onError = () => {
        if (settled) return;
        cleanup();
        // If browser media engine cannot decode format, accept size check and resolve default dimensions
        resolve({ duration: 0, width: 720, height: 1280 });
      };

      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);

      // Timeout fallback (2s)
      setTimeout(() => {
        if (settled) return;
        if (video.readyState >= 1) {
          onLoaded();
        } else {
          onError();
        }
      }, 2000);
    });
  }

  return { duration: 0, width: 720, height: 1280 };
}

export interface PollVideoProcessingOptions {
  onProgress?: (percent: number, message: string) => void;
  timeoutMs?: number;
  initialIntervalMs?: number;
  subsequentIntervalMs?: number;
  firstPhaseDurationMs?: number;
}

/**
 * Follows processing of an uploaded video until READY or FAILED (SOC-2b).
 * Polls GET /v1/uploads/{video_id} up to 15 minutes (2s for first 60s, 5s thereafter).
 * Stops immediately on READY or FAILED.
 * Resumes / polls immediately on visibilitychange when tab is restored.
 */
export async function pollVideoProcessing(
  videoId: string,
  options?: PollVideoProcessingOptions,
): Promise<{ status: 'READY'; videoId: string }> {
  const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000; // 15 minutes
  const initialIntervalMs = options?.initialIntervalMs ?? 2000; // 2s during first minute
  const subsequentIntervalMs = options?.subsequentIntervalMs ?? 5000; // 5s thereafter
  const firstPhaseDurationMs = options?.firstPhaseDurationMs ?? 60 * 1000; // 1 minute

  const startTime = Date.now();
  let finished = false;
  let resolveWait: (() => void) | null = null;

  const handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !finished) {
      resolveWait?.();
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  try {
    while (!finished) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        throw new Error('Quá thời gian chờ xử lý video (15 phút).');
      }

      const { data, response } = await api.upload.GET('/v1/uploads/{video_id}', {
        params: { path: { video_id: videoId } },
      });

      if (response.ok && data) {
        if (data.status === 'READY') {
          options?.onProgress?.(100, 'Video đã sẵn sàng');
          finished = true;
          return { status: 'READY', videoId };
        }

        if (data.status === 'FAILED') {
          finished = true;
          throw new Error(data.error || 'Xử lý video thất bại.');
        }

        const progress = typeof data.progress === 'number' ? data.progress : 50;
        options?.onProgress?.(progress, 'Đang xử lý video…');
      }

      const currentElapsed = Date.now() - startTime;
      if (currentElapsed >= timeoutMs) {
        throw new Error('Quá thời gian chờ xử lý video (15 phút).');
      }

      const delay =
        currentElapsed < firstPhaseDurationMs ? initialIntervalMs : subsequentIntervalMs;
      const sleepTime = Math.min(delay, timeoutMs - currentElapsed);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolveWait = null;
          resolve();
        }, sleepTime);

        resolveWait = () => {
          clearTimeout(timer);
          resolveWait = null;
          resolve();
        };
      });
    }

    throw new Error('Quá thời gian chờ xử lý video (15 phút).');
  } finally {
    finished = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  }
}
