export interface VideoPermissionOptions {
  videoId: string;
  userId?: string | null;
  roles?: string[];
}

interface CacheEntry {
  allowed: boolean;
  expiresAt: number;
}

export class VideoClient {
  private readonly videoSvcUrl: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;

  constructor(videoSvcUrl: string, cacheTtlMs = 60000) {
    this.videoSvcUrl = videoSvcUrl.replace(/\/+$/, '');
    this.cacheTtlMs = Math.min(60000, Math.max(1000, cacheTtlMs));
  }

  private buildCacheKey(videoId: string, userId?: string | null): string {
    return `${userId || 'anonymous'}:${videoId}`;
  }

  async canAccessVideo(options: VideoPermissionOptions): Promise<boolean> {
    const { videoId, userId, roles } = options;
    const cacheKey = this.buildCacheKey(videoId, userId);
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.allowed;
    }

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (userId) {
        headers['X-User-Id'] = userId;
      }
      if (roles && roles.length > 0) {
        headers['X-User-Roles'] = roles.join(',');
      }

      const res = await fetch(`${this.videoSvcUrl}/v1/videos/${videoId}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(2000),
      });

      const allowed = res.status === 200;

      if (this.cache.size >= 10000) {
        const nowMs = Date.now();
        for (const [k, v] of this.cache) {
          if (v.expiresAt <= nowMs) {
            this.cache.delete(k);
          }
        }
        if (this.cache.size >= 10000) {
          let count = 0;
          for (const k of this.cache.keys()) {
            this.cache.delete(k);
            if (++count >= 1000) break;
          }
        }
      }

      this.cache.set(cacheKey, {
        allowed,
        expiresAt: now + this.cacheTtlMs,
      });

      return allowed;
    } catch {
      // In case video-svc is down, timeout or network error, fail closed
      return false;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
