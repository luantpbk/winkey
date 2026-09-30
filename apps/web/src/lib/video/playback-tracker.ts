import type { PlaybackSample, PlaybackHeartbeatBatch } from '@winkey/api-client';
import { api } from '../api-client';
import { tokenStore } from '../auth/token-store';

export interface PlaybackTrackerOptions {
  videoId: string;
  playbackId: string;
  enabled?: boolean;
  endpoint?: string;
  heartbeatIntervalMs?: number;
  apiClient?: typeof api;
  getAccessToken?: () => string | null;
  transport?: (batch: PlaybackHeartbeatBatch, sync?: boolean) => Promise<boolean | number>;
}

export class PlaybackTracker {
  public readonly videoId: string;
  public readonly playbackId: string;
  public readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly heartbeatIntervalMs: number;
  private readonly apiClient: typeof api;
  private readonly getAccessToken: () => string | null;
  private readonly customTransport?: (
    batch: PlaybackHeartbeatBatch,
    sync?: boolean,
  ) => Promise<boolean | number>;

  private seq = 0;
  private playRequestedAt: number | null = null;
  private hasStarted = false;
  private hasEnded = false;

  private isSeeking = false;
  private isStalled = false;
  private stallStartTime: number | null = null;
  private lastPositionSec: number | null = null;

  // Deltas since last sample
  private deltaWatchedMs = 0;
  private deltaRebufferMs = 0;
  private deltaRebufferCount = 0;

  // Quality & format metadata
  private rendition: string | null = null;
  private bitrateKbps: number | null = null;

  // Queue & network state
  private queue: PlaybackSample[] = [];
  private isFlushing = false;
  private retryCount = 0;
  private backoffUntil = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private boundPageHideHandler: (() => void) | null = null;

  constructor(options: PlaybackTrackerOptions) {
    this.videoId = options.videoId;
    this.playbackId = options.playbackId;

    // Use literal process.env.NEXT_PUBLIC_ANALYTICS_ENABLED !== 'false' so Next.js inlines it
    const envEnabled = process.env.NEXT_PUBLIC_ANALYTICS_ENABLED !== 'false';
    this.enabled = options.enabled !== undefined ? options.enabled : envEnabled;

    this.endpoint = options.endpoint || '/v1/playback/heartbeats';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000;
    this.apiClient = options.apiClient ?? api;
    this.getAccessToken = options.getAccessToken ?? (() => tokenStore.get());
    this.customTransport = options.transport;

    if (this.enabled && typeof window !== 'undefined' && typeof document !== 'undefined') {
      this.boundVisibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          // On tab hidden: emit heartbeat + flushSync, stop timer, but keep hasEnded = false
          // so tracking resumes when the user returns (Item 1, PR #128)
          if (this.enabled && this.hasStarted && !this.hasEnded) {
            this.emitSample('heartbeat', this.lastPositionSec ?? 0);
            this.flushSync();
            this.stopHeartbeatTimer();
          }
        } else if (document.visibilityState === 'visible') {
          // On tab visible: restart the periodic heartbeat timer
          if (this.enabled && this.hasStarted && !this.hasEnded) {
            this.startHeartbeatTimer();
          }
        }
      };

      this.boundPageHideHandler = () => {
        // pagehide indicates actual page unload / navigation -> end playback
        this.handlePageHide();
      };

      document.addEventListener('visibilitychange', this.boundVisibilityHandler);
      window.addEventListener('pagehide', this.boundPageHideHandler);
    }
  }

  /**
   * Called when play is requested (e.g. click play or autoplay request).
   */
  public recordPlayRequest(): void {
    if (!this.enabled || this.hasEnded) return;
    if (this.playRequestedAt === null) {
      this.playRequestedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
  }

  /**
   * Called when the first frame is rendered on screen.
   */
  public recordFirstFrame(positionSec = 0): void {
    if (!this.enabled || this.hasStarted || this.hasEnded) return;
    this.hasStarted = true;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const playReq = this.playRequestedAt ?? now;
    const startupMs = Math.max(0, Math.floor(now - playReq));

    this.lastPositionSec = positionSec;

    // Emit start sample (seq = 0)
    this.emitSample('start', positionSec, { startupMs });

    // Flush start sample and start heartbeat interval
    void this.flush();
    this.startHeartbeatTimer();
  }

  /**
   * Called on media 'timeupdate' events during active playback.
   */
  public recordTimeUpdate(currentTimeSec: number): void {
    if (!this.enabled || this.hasEnded) return;
    if (!this.hasStarted) {
      this.recordFirstFrame(currentTimeSec);
      return;
    }
    if (this.isSeeking || this.isStalled) {
      this.lastPositionSec = currentTimeSec;
      return;
    }

    if (this.lastPositionSec !== null) {
      const deltaSec = currentTimeSec - this.lastPositionSec;
      // Clamp forward progress to [0, 2s] so sudden jumps or seeks never count
      if (deltaSec > 0) {
        const clampedSec = Math.min(deltaSec, 2.0);
        this.deltaWatchedMs += clampedSec * 1000;
      }
    }
    this.lastPositionSec = currentTimeSec;
  }

  /**
   * Called when playback is paused.
   */
  public recordPause(): void {
    if (!this.enabled || this.hasEnded) return;
    if (this.isStalled) {
      this.isStalled = false;
      if (this.stallStartTime !== null) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.deltaRebufferMs += Math.max(0, now - this.stallStartTime);
        this.stallStartTime = null;
      }
    }
  }

  /**
   * Called when seeking begins.
   */
  public recordSeeking(): void {
    if (!this.enabled || this.hasEnded) return;
    this.isSeeking = true;
  }

  /**
   * Called when seeking finishes.
   * If buffering occurs after 'seeked' before 'playing' fires, recordWaiting()
   * will correctly identify it as a stall and track rebuffer metrics.
   */
  public recordSeeked(currentTimeSec: number): void {
    if (!this.enabled || this.hasEnded) return;
    this.isSeeking = false;
    this.lastPositionSec = currentTimeSec;
  }

  /**
   * Called when player enters waiting/buffering state.
   * Notes:
   * 1. Initial load before first frame is NOT a stall.
   * 2. Buffering while actively seeking (isSeeking = true) is part of seek latency,
   *    not a playback stall.
   * 3. Buffering after seek completion (isSeeking = false) while waiting for media
   *    pipeline to resume is tracked as a stall until recordPlaying() fires.
   */
  public recordWaiting(): void {
    if (!this.enabled || !this.hasStarted || this.hasEnded) return;
    if (this.isSeeking || this.isStalled) return;

    this.isStalled = true;
    this.stallStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.deltaRebufferCount += 1;
  }

  /**
   * Called when playback resumes from pause or stall.
   */
  public recordPlaying(currentTimeSec?: number): void {
    if (!this.enabled || this.hasEnded) return;

    if (!this.hasStarted) {
      this.recordFirstFrame(currentTimeSec ?? 0);
      return;
    }

    if (this.isStalled) {
      this.isStalled = false;
      if (this.stallStartTime !== null) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.deltaRebufferMs += Math.max(0, now - this.stallStartTime);
        this.stallStartTime = null;
      }
    }

    if (currentTimeSec !== undefined) {
      this.lastPositionSec = currentTimeSec;
    }
  }

  /**
   * Called when rendition or quality level changes.
   */
  public setRendition(rendition: string | null, bitrateKbps: number | null): void {
    if (!this.enabled || this.hasEnded) return;
    this.rendition = rendition ? rendition.slice(0, 16) : null;
    this.bitrateKbps =
      bitrateKbps !== null && !isNaN(bitrateKbps)
        ? Math.max(0, Math.min(200000, Math.floor(bitrateKbps)))
        : null;
  }

  /**
   * Called on playback completion ('ended').
   */
  public recordEnded(currentTimeSec?: number): void {
    if (!this.enabled || this.hasEnded) return;
    this.hasEnded = true;
    this.stopHeartbeatTimer();

    const pos = currentTimeSec ?? this.lastPositionSec ?? 0;
    this.emitSample('end', pos);
    void this.flush();
  }

  /**
   * Called on fatal playback error (e.g. hls.js fatal error).
   */
  public recordError(errorCode: string, currentTimeSec?: number): void {
    if (!this.enabled || this.hasEnded) return;
    this.hasEnded = true;
    this.stopHeartbeatTimer();

    const pos = currentTimeSec ?? this.lastPositionSec ?? 0;
    this.emitSample('end', pos, { errorCode });
    void this.flush();
  }

  /**
   * Handles page hide / unload / terminal exit.
   */
  public handlePageHide(): void {
    if (!this.enabled || this.hasEnded) {
      // If already ended, just flush any remaining queued samples synchronously
      this.flushSync();
      return;
    }

    this.hasEnded = true;
    this.stopHeartbeatTimer();

    const pos = this.lastPositionSec ?? 0;
    this.emitSample('end', pos);
    this.flushSync();
  }

  /**
   * Tears down listeners and destroys tracker on player unmount.
   */
  public destroy(): void {
    if (this.boundVisibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.boundPageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.boundPageHideHandler);
      this.boundPageHideHandler = null;
    }

    this.stopHeartbeatTimer();

    if (this.enabled && !this.hasEnded && this.hasStarted) {
      this.hasEnded = true;
      const pos = this.lastPositionSec ?? 0;
      this.emitSample('end', pos);
      this.flushSync();
    }
  }

  /**
   * Emits a single sample and queues it for batching.
   */
  private emitSample(
    kind: 'start' | 'heartbeat' | 'end',
    positionSec: number,
    extra?: { startupMs?: number; errorCode?: string },
  ): void {
    // If currently stalled when emitting, accumulate the elapsed stall time and keep running
    if (this.isStalled && this.stallStartTime !== null) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.deltaRebufferMs += Math.max(0, now - this.stallStartTime);
      this.stallStartTime = now;
    }

    const posMs = Math.max(0, Math.min(86400000, Math.floor((positionSec || 0) * 1000)));
    const watchedMs = Math.max(0, Math.min(600000, Math.floor(this.deltaWatchedMs)));
    const rebufferMs = Math.max(0, Math.min(600000, Math.floor(this.deltaRebufferMs)));
    const rebufferCount = Math.max(0, Math.min(1000, this.deltaRebufferCount));

    // Reset deltas
    this.deltaWatchedMs = 0;
    this.deltaRebufferMs = 0;
    this.deltaRebufferCount = 0;

    const sample: PlaybackSample = {
      playback_id: this.playbackId,
      video_id: this.videoId,
      kind,
      seq: this.seq++,
      sent_at: new Date().toISOString(),
      position_ms: posMs,
      watched_ms: watchedMs,
      rebuffer_ms: rebufferMs,
      rebuffer_count: rebufferCount,
      rendition: this.rendition,
      bitrate_kbps: this.bitrateKbps,
      client: 'web',
    };

    if (kind === 'start' && extra?.startupMs !== undefined) {
      sample.startup_ms = Math.max(0, Math.min(600000, extra.startupMs));
    }
    if (kind === 'end' && extra?.errorCode) {
      sample.error_code = extra.errorCode.slice(0, 64);
    }

    this.queue.push(sample);

    // Cap queue at 100 during extended back-off / failure (drop oldest to avoid memory leaks)
    while (this.queue.length > 100) {
      this.queue.shift();
    }

    // If 20 samples queued, flush immediately
    if (this.queue.length >= 20) {
      void this.flush();
    }
  }

  private startHeartbeatTimer(): void {
    this.stopHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (this.hasEnded || !this.enabled) {
        this.stopHeartbeatTimer();
        return;
      }
      // Skip empty heartbeats while paused / idle when all deltas are 0 and not currently stalled
      if (
        this.deltaWatchedMs === 0 &&
        this.deltaRebufferMs === 0 &&
        this.deltaRebufferCount === 0 &&
        !this.isStalled
      ) {
        return;
      }
      this.emitSample('heartbeat', this.lastPositionSec ?? 0);
      void this.flush();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Prepares the next batch adhering to contract limits (<= 20 samples, <= 16 KiB).
   */
  private getResolvedEndpoint(): string {
    if (this.endpoint.startsWith('http://') || this.endpoint.startsWith('https://')) {
      return this.endpoint;
    }
    if (
      typeof window !== 'undefined' &&
      window.location?.origin &&
      window.location.origin !== 'null'
    ) {
      return `${window.location.origin}${this.endpoint}`;
    }
    return `http://localhost${this.endpoint}`;
  }

  private inflightBatch: PlaybackSample[] | null = null;

  /**
   * Prepares the next batch adhering to contract limits (<= 20 samples, <= 16 KiB).
   * Atomically splices samples from the queue.
   */
  private prepareBatch(): { samples: PlaybackSample[]; payload: string } | null {
    if (this.queue.length === 0) return null;

    let takeCount = Math.min(20, this.queue.length);
    let batch = this.queue.slice(0, takeCount);
    let payload = JSON.stringify({ samples: batch });

    // Ensure body <= 16384 bytes
    while (new TextEncoder().encode(payload).length > 16384 && takeCount > 1) {
      takeCount -= 1;
      batch = this.queue.slice(0, takeCount);
      payload = JSON.stringify({ samples: batch });
    }

    const taken = this.queue.splice(0, takeCount);
    return { samples: taken, payload: JSON.stringify({ samples: taken }) };
  }

  /**
   * Asynchronously flushes the batch using api.video.POST to include Authorization.
   */
  public async flush(): Promise<void> {
    if (!this.enabled || this.isFlushing || this.queue.length === 0) return;
    if (Date.now() < this.backoffUntil) return;

    const prepared = this.prepareBatch();
    if (!prepared) return;

    this.isFlushing = true;
    const { samples } = prepared;
    this.inflightBatch = samples;

    try {
      if (this.customTransport) {
        const res = await this.customTransport({ samples }, false);
        if (res === 429) {
          // Drop batch and back off for 60s
          this.inflightBatch = null;
          this.backoffUntil = Date.now() + 60000;
          this.retryCount = 0;
        } else if (res === true || (typeof res === 'number' && res >= 200 && res < 300)) {
          this.inflightBatch = null;
          this.retryCount = 0;
        } else {
          // Failure
          this.handleFlushFailure();
        }
      } else {
        const { response } = await this.apiClient.video.POST('/v1/playback/heartbeats', {
          body: { samples },
        });

        if (response?.status === 429) {
          // 429 -> drop and back off 60 s
          this.inflightBatch = null;
          this.backoffUntil = Date.now() + 60000;
          this.retryCount = 0;
        } else if (response?.ok) {
          this.inflightBatch = null;
          this.retryCount = 0;
        } else {
          this.handleFlushFailure();
        }
      }
    } catch {
      // Network error -> retry once on next flush, then drop
      this.handleFlushFailure();
    } finally {
      this.isFlushing = false;
    }
  }

  private handleFlushFailure(): void {
    if (!this.inflightBatch) return;

    if (this.retryCount === 0) {
      // Keep in queue to retry once
      this.queue.unshift(...this.inflightBatch);
      this.retryCount = 1;
      while (this.queue.length > 100) {
        this.queue.shift();
      }
    } else {
      // Already retried once, drop to avoid blocking or memory leak
      this.retryCount = 0;
    }
    this.inflightBatch = null;
  }

  /**
   * Synchronous flush for pagehide / visibilitychange.
   * Per ADR-022 / PR #128:
   * - If a user token is present, sendBeacon CANNOT include custom Authorization headers.
   *   We use fetch with keepalive: true and the Authorization header so the viewer_key is attributed properly.
   * - sendBeacon is used only when there is no token (anonymous viewer).
   */
  public flushSync(): void {
    if (!this.enabled || this.queue.length === 0) return;
    if (Date.now() < this.backoffUntil) return;

    const prepared = this.prepareBatch();
    if (!prepared) return;

    const { samples, payload } = prepared;

    if (this.customTransport) {
      void this.customTransport({ samples }, true);
      return;
    }

    const url = this.getResolvedEndpoint();
    const token = this.getAccessToken();

    // Authenticated viewer: use keepalive fetch with Authorization header
    if (token) {
      if (typeof fetch === 'function') {
        try {
          fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: payload,
            keepalive: true,
          }).catch(() => {});
        } catch {
          // Ignored in synchronous unload path
        }
      }
      return;
    }

    // Anonymous viewer (no token): sendBeacon is supported and preferred
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([payload], { type: 'application/json' });
        const sent = navigator.sendBeacon(url, blob);
        if (sent) {
          return;
        }
      } catch {
        // Fall back to keepalive fetch
      }
    }

    // Fallback: fetch with keepalive: true without token
    if (typeof fetch === 'function') {
      try {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Ignored in beacon path
      }
    }
  }

  // Getters for testing
  public getQueueLength(): number {
    return this.queue.length + (this.inflightBatch ? this.inflightBatch.length : 0);
  }

  public getQueue(): readonly PlaybackSample[] {
    return this.queue;
  }

  public isBackoff(): boolean {
    return Date.now() < this.backoffUntil;
  }
}
