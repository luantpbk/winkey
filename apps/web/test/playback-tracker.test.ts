import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackTracker } from '../src/lib/video/playback-tracker';
import type { PlaybackHeartbeatBatch } from '@winkey/api-client';
import { tokenStore } from '../src/lib/auth/token-store';

describe('PlaybackTracker Unit Tests (R1 telemetry & QoE)', () => {
  const defaultVideoId = '0192f5e4-7c1a-7b3e-9d2a-test-video';
  const defaultPlaybackId = '0192f5e4-7c1a-7b3e-9d2a-test-playback';

  beforeEach(() => {
    vi.useFakeTimers();
    tokenStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    tokenStore.clear();
  });

  describe('Lifecycle: Start Sample & Startup Time', () => {
    it('records start sample with startup_ms when first frame renders', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      // User requests play at t = 0
      tracker.recordPlayRequest();

      // Buffering and media preparation takes 450 ms
      await vi.advanceTimersByTimeAsync(450);

      // First frame shown at position 0.0s
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      // Start sample should be emitted and flushed
      expect(mockTransport).toHaveBeenCalledTimes(1);
      expect(sentBatches).toHaveLength(1);

      const batch = sentBatches[0];
      expect(batch.samples).toHaveLength(1);

      const sample = batch.samples[0];
      expect(sample.video_id).toBe(defaultVideoId);
      expect(sample.playback_id).toBe(defaultPlaybackId);
      expect(sample.kind).toBe('start');
      expect(sample.seq).toBe(0);
      expect(sample.startup_ms).toBe(450);
      expect(sample.position_ms).toBe(0);
      expect(sample.client).toBe('web');
      expect(sample.watched_ms).toBe(0);
      expect(sample.rebuffer_ms).toBe(0);
      expect(sample.rebuffer_count).toBe(0);

      tracker.destroy();
    });

    it('handles recordPlaying without prior recordPlayRequest gracefully (startup_ms = 0)', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(1.5);
      await Promise.resolve();

      expect(mockTransport).toHaveBeenCalledTimes(1);
      const sample = sentBatches[0].samples[0];
      expect(sample.kind).toBe('start');
      expect(sample.seq).toBe(0);
      expect(sample.startup_ms).toBe(0);
      expect(sample.position_ms).toBe(1500);

      tracker.destroy();
    });
  });

  describe('Heartbeats & Delta Calculations', () => {
    it('sends heartbeat every 30s with accurate watched_ms delta', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordPlayRequest();
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(1); // start sample

      // Play smoothly for 30s: 30 time updates of 1s each
      for (let s = 1; s <= 30; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      await Promise.resolve();

      // 30s elapsed -> heartbeat timer fires
      expect(sentBatches).toHaveLength(2);
      const hb1 = sentBatches[1].samples[0];
      expect(hb1.kind).toBe('heartbeat');
      expect(hb1.seq).toBe(1);
      expect(hb1.position_ms).toBe(30000);
      expect(hb1.watched_ms).toBe(30000);
      expect(hb1.rebuffer_ms).toBe(0);
      expect(hb1.rebuffer_count).toBe(0);

      // Next 30s period: play 10s then pause for 20s
      for (let s = 31; s <= 40; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      tracker.recordPause();
      await vi.advanceTimersByTimeAsync(20000); // idle while paused
      await Promise.resolve();

      // Heartbeat 2 fires
      expect(sentBatches).toHaveLength(3);
      const hb2 = sentBatches[2].samples[0];
      expect(hb2.kind).toBe('heartbeat');
      expect(hb2.seq).toBe(2);
      expect(hb2.position_ms).toBe(40000);
      // Delta should only be the 10s actually played!
      expect(hb2.watched_ms).toBe(10000);

      tracker.destroy();
    });

    it('does NOT send empty heartbeats while paused (skip when all deltas are 0)', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(1); // start sample

      // Play 5s then pause
      for (let s = 1; s <= 5; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      tracker.recordPause();

      // Advance 25s to hit the first 30s mark
      await vi.advanceTimersByTimeAsync(25000);
      await Promise.resolve();

      // First heartbeat flushes the 5s played before pausing
      expect(sentBatches).toHaveLength(2);
      expect(sentBatches[1].samples[0].watched_ms).toBe(5000);

      // Advance another full 30s period entirely paused
      await vi.advanceTimersByTimeAsync(30000);
      await Promise.resolve();

      // No new heartbeat should be sent because all deltas are 0!
      expect(sentBatches).toHaveLength(2);

      // Advance yet another 60s paused
      await vi.advanceTimersByTimeAsync(60000);
      await Promise.resolve();

      // Still no empty heartbeats sent
      expect(sentBatches).toHaveLength(2);

      tracker.destroy();
    });

    it('includes rendition and bitrate metadata in samples', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.setRendition('1080p', 5000);
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      const startSample = sentBatches[0].samples[0];
      expect(startSample.rendition).toBe('1080p');
      expect(startSample.bitrate_kbps).toBe(5000);

      // Switch to 720p and advance time while playing so heartbeat is not skipped
      tracker.setRendition('720p', 2800);
      for (let s = 1; s <= 30; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      await Promise.resolve();

      expect(sentBatches).toHaveLength(2);
      const hbSample = sentBatches[1].samples[0];
      expect(hbSample.rendition).toBe('720p');
      expect(hbSample.bitrate_kbps).toBe(2800);

      tracker.destroy();
    });
  });

  describe('Seeking and Progress Clamping', () => {
    it('excludes seeks from watched_ms during seek operation', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      // Play 5 seconds normally
      for (let s = 1; s <= 5; s++) {
        await vi.advanceTimersByTimeAsync(1000);
        tracker.recordTimeUpdate(s);
      }

      // User seeks from 5s to 120s (a 115s jump!)
      tracker.recordSeeking();
      await vi.advanceTimersByTimeAsync(500);
      tracker.recordSeeked(120);

      // Play another 5 seconds at 120s..125s
      for (let s = 121; s <= 125; s++) {
        await vi.advanceTimersByTimeAsync(1000);
        tracker.recordTimeUpdate(s);
      }

      // Advance remaining time to 30s heartbeat interval
      await vi.advanceTimersByTimeAsync(19500);
      await Promise.resolve();

      expect(sentBatches).toHaveLength(2);
      const hb = sentBatches[1].samples[0];
      expect(hb.kind).toBe('heartbeat');
      expect(hb.position_ms).toBe(125000);
      // Total watched_ms must be 5000ms + 5000ms = 10000ms (NOT including the 115s jump!)
      expect(hb.watched_ms).toBe(10000);

      tracker.destroy();
    });

    it('clamps single-step progress jumps > 2s to at most 2s', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      // Jump 10 seconds in a single timeupdate step without seeking event
      await vi.advanceTimersByTimeAsync(1000);
      tracker.recordTimeUpdate(10);

      await vi.advanceTimersByTimeAsync(29000);
      await Promise.resolve();

      expect(sentBatches).toHaveLength(2);
      const hb = sentBatches[1].samples[0];
      // Clamped to 2000 ms max
      expect(hb.watched_ms).toBe(2000);

      tracker.destroy();
    });
  });

  describe('Stall and Rebuffering Tracking (including Post-Seek Buffering)', () => {
    it('does NOT count initial buffering before first frame as a stall', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordPlayRequest();

      // Player waits while loading initial manifest/segments
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(800);

      // First frame shown
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      const start = sentBatches[0].samples[0];
      expect(start.kind).toBe('start');
      expect(start.rebuffer_count).toBe(0);
      expect(start.rebuffer_ms).toBe(0);

      tracker.destroy();
    });

    it('records rebuffering count and duration during playback', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      // Play for 5s
      for (let s = 1; s <= 5; s++) {
        await vi.advanceTimersByTimeAsync(1000);
        tracker.recordTimeUpdate(s);
      }

      // Stall 1: buffering for 1.2s
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(1200);
      tracker.recordPlaying(5);

      // Play another 5s
      for (let s = 6; s <= 10; s++) {
        await vi.advanceTimersByTimeAsync(1000);
        tracker.recordTimeUpdate(s);
      }

      // Stall 2: buffering for 800ms
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(800);
      tracker.recordPlaying(10);

      // Advance to 30s heartbeat
      await vi.advanceTimersByTimeAsync(18000);
      await Promise.resolve();

      expect(sentBatches).toHaveLength(2);
      const hb = sentBatches[1].samples[0];
      expect(hb.kind).toBe('heartbeat');
      expect(hb.rebuffer_count).toBe(2);
      expect(hb.rebuffer_ms).toBe(2000); // 1200 + 800

      tracker.destroy();
    });

    it('tracks waiting after seeked as a stall, but ignores waiting during active seeking', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      // 1. User starts seeking: isSeeking = true
      tracker.recordSeeking();
      // Waiting during seeking is part of seek operation -> must NOT count as a stall
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(500);

      // 2. Seeking completes to 45s: isSeeking = false
      tracker.recordSeeked(45);

      // 3. Media player needs to buffer new segments at 45s: recordWaiting() fires after seeked
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(1500); // stalls for 1.5s
      tracker.recordPlaying(45); // resumes playback

      // Play 5s at 45s..50s
      for (let s = 46; s <= 50; s++) {
        await vi.advanceTimersByTimeAsync(1000);
        tracker.recordTimeUpdate(s);
      }

      // Advance to 30s interval
      await vi.advanceTimersByTimeAsync(23000);
      await Promise.resolve();

      expect(sentBatches).toHaveLength(2);
      const hb = sentBatches[1].samples[0];
      expect(hb.kind).toBe('heartbeat');
      expect(hb.rebuffer_count).toBe(1); // exactly 1 stall (the one after seeked)
      expect(hb.rebuffer_ms).toBe(1500);
      expect(hb.watched_ms).toBe(5000);

      tracker.destroy();
    });
  });

  describe('Lifecycle: End, Errors, and Tab Visibility', () => {
    it('emits end sample on video ended and stops heartbeat timer', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(1);

      // Video finishes at 45.2s
      tracker.recordEnded(45.2);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(2);

      const end = sentBatches[1].samples[0];
      expect(end.kind).toBe('end');
      expect(end.seq).toBe(1);
      expect(end.position_ms).toBe(45200);

      // Advancing timer does NOT fire further heartbeats
      await vi.advanceTimersByTimeAsync(60000);
      expect(sentBatches).toHaveLength(2);

      tracker.destroy();
    });

    it('emits end sample with error_code on fatal playback error', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      // Fatal error after 12s
      tracker.recordError('manifestLoadError', 12.0);
      await Promise.resolve();

      expect(sentBatches).toHaveLength(2);
      const end = sentBatches[1].samples[0];
      expect(end.kind).toBe('end');
      expect(end.error_code).toBe('manifestLoadError');
      expect(end.position_ms).toBe(12000);

      tracker.destroy();
    });

    it('emits end sample on unmount via destroy()', async () => {
      const syncCalls: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch, sync?: boolean) => {
        if (sync) syncCalls.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      for (let s = 1; s <= 5; s++) {
        tracker.recordTimeUpdate(s);
      }

      // Unmount component
      tracker.destroy();

      expect(syncCalls).toHaveLength(1);
      const end = syncCalls[0].samples[0];
      expect(end.kind).toBe('end');
      expect(end.position_ms).toBe(5000);
      expect(end.watched_ms).toBe(5000);
    });

    it('handles visibilitychange: hidden -> heartbeat + flushSync (keeps hasEnded=false) -> visible -> 30s playback -> heartbeat', async () => {
      const batches: { batch: PlaybackHeartbeatBatch; sync?: boolean }[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch, sync?: boolean) => {
        batches.push({ batch, sync });
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(batches).toHaveLength(1); // start sample

      // Play for 10s
      for (let s = 1; s <= 10; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }

      // User switches tab: visibilitychange -> hidden
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
        writable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // Must emit a 'heartbeat' (NOT 'end') and flush synchronously
      expect(batches).toHaveLength(2);
      expect(batches[1].sync).toBe(true);
      const hiddenSample = batches[1].batch.samples[0];
      expect(hiddenSample.kind).toBe('heartbeat');
      expect(hiddenSample.watched_ms).toBe(10000);

      // User returns to tab: visibilitychange -> visible
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
        writable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // Play 30s more after returning
      for (let s = 11; s <= 40; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      await Promise.resolve();

      // Periodic timer restarted on visible -> fires heartbeat with watched_ms ≈ 30000!
      expect(batches).toHaveLength(3);
      const returnedSample = batches[2].batch.samples[0];
      expect(returnedSample.kind).toBe('heartbeat');
      expect(returnedSample.watched_ms).toBe(30000);
      expect(returnedSample.position_ms).toBe(40000);

      tracker.destroy();
    });
  });

  describe('Authorization & Transport (ADR-022)', () => {
    it('sends Authorization header via api.video.POST when viewer is authenticated', async () => {
      let capturedBody: any = null;
      let capturedEndpoint = '';

      const mockApiClient = {
        video: {
          POST: vi.fn(async (endpoint: string, options: any) => {
            capturedEndpoint = endpoint;
            capturedBody = options.body;
            return {
              data: { accepted: options.body.samples.length },
              response: { ok: true, status: 202 } as Response,
            };
          }),
        },
      } as any;

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        apiClient: mockApiClient,
        getAccessToken: () => 'valid-jwt-token-123',
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      expect(mockApiClient.video.POST).toHaveBeenCalledTimes(1);
      expect(capturedEndpoint).toBe('/v1/playback/heartbeats');
      expect(capturedBody.samples).toHaveLength(1);
      expect(capturedBody.samples[0].kind).toBe('start');

      tracker.destroy();
    });

    it('flushSync uses keepalive fetch with Authorization when token is present, bypassing sendBeacon', () => {
      const mockFetch = vi.fn(async () => new Response(null, { status: 202 }));
      const mockSendBeacon = vi.fn(() => true);

      globalThis.fetch = mockFetch as any;
      Object.defineProperty(navigator, 'sendBeacon', {
        value: mockSendBeacon,
        configurable: true,
        writable: true,
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        getAccessToken: () => 'my-secret-access-token',
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      // Trigger flushSync via pagehide
      tracker.handlePageHide();

      // sendBeacon must NOT be called because viewer has a token
      expect(mockSendBeacon).not.toHaveBeenCalled();

      // fetch must be called with keepalive: true and Authorization: Bearer
      expect(mockFetch).toHaveBeenCalled();
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as unknown as [
        string,
        RequestInit,
      ];
      const fetchOpts = lastCall[1];
      expect(fetchOpts.keepalive).toBe(true);
      expect((fetchOpts.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer my-secret-access-token',
      );

      tracker.destroy();
    });

    it('flushSync uses sendBeacon when viewer is anonymous (no token)', () => {
      const mockFetch = vi.fn(async () => new Response(null, { status: 202 }));
      const mockSendBeacon = vi.fn(() => true);

      globalThis.fetch = mockFetch as any;
      Object.defineProperty(navigator, 'sendBeacon', {
        value: mockSendBeacon,
        configurable: true,
        writable: true,
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        getAccessToken: () => null, // Anonymous
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      tracker.handlePageHide();

      // sendBeacon must be used for anonymous viewers
      expect(mockSendBeacon).toHaveBeenCalled();

      tracker.destroy();
    });
  });

  describe('Batching Limits, Queue Capping, Retry Policy, and 429 Back-off', () => {
    it('flushes when 20 samples accumulate in queue', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(1); // start sample

      // Queue 20 additional heartbeat samples by advancing time and simulating playback
      for (let i = 0; i < 20; i++) {
        tracker.recordTimeUpdate(i + 1);
        await vi.advanceTimersByTimeAsync(30000);
        await Promise.resolve();
      }

      // Should have sent batches
      expect(sentBatches.length).toBeGreaterThanOrEqual(2);
      expect(tracker.getQueueLength()).toBe(0);

      tracker.destroy();
    });

    it('caps queue at 100 during extended back-off, dropping oldest samples', async () => {
      // Transport that triggers 429 back-off on initial flush
      const mockTransport = vi.fn(async () => 429);

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        heartbeatIntervalMs: 500,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(tracker.isBackoff()).toBe(true);

      // Add 110 samples during the 60s back-off window (110 * 500ms = 55s < 60s)
      for (let i = 1; i <= 110; i++) {
        tracker.recordTimeUpdate(i * 0.5);
        await vi.advanceTimersByTimeAsync(500);
      }

      // During back-off, flushes are blocked, so samples queue up
      // Queue length must never exceed 100
      expect(tracker.getQueueLength()).toBe(100);
      const queue = tracker.getQueue();
      expect(queue.length).toBe(100);

      // The seq of the first sample in queue should be > 0 because oldest samples were dropped
      expect(queue[0].seq).toBeGreaterThan(0);

      tracker.destroy();
    });

    it('retries once on failure then drops batch', async () => {
      let callCount = 0;
      const mockTransport = vi.fn(async () => {
        callCount++;
        return 500; // Network error / server error
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      // Call 1 fails -> batch is retained for retry
      expect(callCount).toBe(1);
      expect(tracker.getQueueLength()).toBe(1);

      // Trigger second flush via heartbeat with active playback
      tracker.recordTimeUpdate(5);
      await vi.advanceTimersByTimeAsync(30000);
      await Promise.resolve();

      // Call 2 fails -> exceeded retry once, batch dropped
      expect(callCount).toBe(2);
      expect(tracker.getQueueLength()).toBe(0);

      tracker.destroy();
    });

    it('drops batch immediately and backs off for 60s on 429 response', async () => {
      let callCount = 0;
      const mockTransport = vi.fn(async () => {
        callCount++;
        if (callCount === 1) return 429;
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();

      expect(callCount).toBe(1);
      expect(tracker.getQueueLength()).toBe(0); // dropped!
      expect(tracker.isBackoff()).toBe(true);

      // Attempt to flush during back-off (at 30s) -> should be skipped!
      tracker.recordTimeUpdate(5);
      await vi.advanceTimersByTimeAsync(30000);
      await Promise.resolve();
      expect(callCount).toBe(1);
      expect(tracker.isBackoff()).toBe(true);

      // After 60s (at 60s+), back-off is cleared, heartbeat fires and succeeds
      tracker.recordTimeUpdate(10);
      await vi.advanceTimersByTimeAsync(30000);
      await Promise.resolve();
      expect(callCount).toBe(2);
      expect(tracker.isBackoff()).toBe(false);

      tracker.destroy();
    });

    it('does nothing when disabled (NEXT_PUBLIC_ANALYTICS_ENABLED = false)', async () => {
      const mockTransport = vi.fn(async () => true);

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        enabled: false,
        transport: mockTransport,
      });

      tracker.recordPlayRequest();
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      tracker.recordTimeUpdate(10);
      tracker.recordWaiting();
      tracker.recordEnded(10);
      tracker.destroy();
      await Promise.resolve();

      expect(mockTransport).not.toHaveBeenCalled();
      expect(tracker.getQueueLength()).toBe(0);
    });
  });

  describe('QOE2 Deterministic Event-Sequence Tests (ADR-030 / Issue #257)', () => {
    it('1. wait→seek: stops in-flight stall when seek starts, does not count seek duration as rebuffer', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      // Playback starts
      tracker.recordPlayRequest();
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(1); // start sample

      // Play normally for 5s
      for (let s = 1; s <= 5; s++) {
        await vi.advanceTimersByTimeAsync(1000);
        tracker.recordTimeUpdate(s);
      }

      // Stall begins at t = 5000ms
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(800); // 800ms of stall

      // User seeks at t = 5800ms: seek starts -> in-flight stall MUST stop/freeze
      tracker.recordSeeking();

      // Seeking operation takes 1200ms (t = 5800ms -> 7000ms)
      await vi.advanceTimersByTimeAsync(1200);

      // Spurious waiting while actively seeking must be ignored
      tracker.recordWaiting();

      // Seek finishes to 60s
      tracker.recordSeeked(60);

      // Playback resumes at 60s
      tracker.recordPlaying(60);

      // Play 5s after seek (61s..65s)
      for (let s = 61; s <= 65; s++) {
        await vi.advanceTimersByTimeAsync(1000);
        tracker.recordTimeUpdate(s);
      }

      // Advance remaining time to 30s heartbeat interval
      await vi.advanceTimersByTimeAsync(18000);
      await Promise.resolve();

      expect(sentBatches).toHaveLength(2);
      const hb = sentBatches[1].samples[0];
      expect(hb.kind).toBe('heartbeat');
      // Exactly 1 stall count (the stall before seek)
      expect(hb.rebuffer_count).toBe(1);
      // Exactly 800ms rebuffer (seek duration 1200ms is NOT counted!)
      expect(hb.rebuffer_ms).toBe(800);
      // Watched time is 5s before seek + 5s after seek = 10s
      expect(hb.watched_ms).toBe(10000);
      expect(hb.position_ms).toBe(65000);

      tracker.destroy();
    });

    it('2. wait→hide→return: freezes in-flight stall on hidden, accumulates 0ms while hidden, unfreezes on visible', async () => {
      const batches: { batch: PlaybackHeartbeatBatch; sync?: boolean }[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch, sync?: boolean) => {
        batches.push({ batch, sync });
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordPlayRequest();
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(batches).toHaveLength(1); // start sample

      // Play for 5s
      for (let s = 1; s <= 5; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }

      // Stall begins at t = 5000ms
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(1200); // 1200ms stall before hide

      // User switches tab (hidden): in-flight stall freezes, sends heartbeat synchronously
      tracker.recordVisibilityChange(true);

      expect(batches).toHaveLength(2);
      expect(batches[1].sync).toBe(true);
      const hiddenSample = batches[1].batch.samples[0];
      expect(hiddenSample.kind).toBe('heartbeat');
      expect(hiddenSample.rebuffer_count).toBe(1);
      expect(hiddenSample.rebuffer_ms).toBe(1200);
      expect(hiddenSample.watched_ms).toBe(5000);

      // Tab remains hidden for 60 seconds (1 minute in background!)
      await vi.advanceTimersByTimeAsync(60000);

      // Waiting events fired while hidden must be ignored ("never start a stall while hidden")
      tracker.recordWaiting();

      // User returns to tab (visible): unfreezes the in-flight stall clock
      tracker.recordVisibilityChange(false);

      // Still waiting for 800ms after returning
      await vi.advanceTimersByTimeAsync(800);

      // Playback resumes at position 5s
      tracker.recordPlaying(5);

      // Play for 30s smoothly
      for (let s = 6; s <= 35; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      await Promise.resolve();

      expect(batches).toHaveLength(3);
      const returnSample = batches[2].batch.samples[0];
      expect(returnSample.kind).toBe('heartbeat');
      // The 60,000ms background time was NOT added! Only the 800ms visible stall is tracked
      expect(returnSample.rebuffer_ms).toBe(800);
      // Rebuffer count for this period is 0 (already counted in the earlier sample for this single stall)
      expect(returnSample.rebuffer_count).toBe(0);
      expect(returnSample.watched_ms).toBe(30000);

      tracker.destroy();
    });

    it('3. paused waiting: never starts a stall while paused, accumulates 0 rebuffer_count and 0 rebuffer_ms', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.recordPlayRequest();
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(1); // start sample

      // Play for 5s
      for (let s = 1; s <= 5; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }

      // User pauses playback
      tracker.recordPause();

      // While paused, browser/player buffers (e.g. background buffer eviction or track change)
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(15000); // 15 seconds paused waiting
      tracker.recordWaiting(); // another waiting event while paused

      // User resumes playback
      tracker.recordPlayRequest();
      tracker.recordPlaying(5);

      // Play for 25s (clock t = 20s..45s)
      for (let s = 6; s <= 30; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      // Advance remaining 5s to hit second 30s interval mark (clock t = 50s..60s)
      await vi.advanceTimersByTimeAsync(15000);
      await Promise.resolve();

      expect(sentBatches).toHaveLength(3);
      const hb1 = sentBatches[1].samples[0];
      expect(hb1.kind).toBe('heartbeat');
      // In first 30s period: 5s played before pause + 10s played after pause = 15s
      expect(hb1.rebuffer_count).toBe(0);
      expect(hb1.rebuffer_ms).toBe(0);
      expect(hb1.watched_ms).toBe(15000);

      const hb2 = sentBatches[2].samples[0];
      expect(hb2.kind).toBe('heartbeat');
      // In second 30s period: remaining 15s played
      expect(hb2.rebuffer_count).toBe(0);
      expect(hb2.rebuffer_ms).toBe(0);
      expect(hb2.watched_ms).toBe(15000);

      tracker.destroy();
    });

    it('4. metadata/seek timeupdate before play: timeupdate before play never starts first frame, startup begins on playing after loadeddata', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      // 1. Initial metadata loads, position restored to 42s -> timeupdate fires before play
      tracker.recordTimeUpdate(42.0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(0); // MUST NOT start

      // 2. loadeddata fires
      tracker.recordLoadedData();
      await Promise.resolve();
      expect(sentBatches).toHaveLength(0); // MUST NOT start (playing has not fired!)

      // 3. User scrubs or seeks while paused before play
      tracker.recordSeeking();
      tracker.recordSeeked(45.0);
      tracker.recordTimeUpdate(45.0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(0); // MUST NOT start

      // 4. Advance 5 seconds while user looks at poster
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentBatches).toHaveLength(0);

      // 5. User clicks play at t = 5000ms
      tracker.recordPlayRequest();

      // Media decoder takes 300ms to decode first frame after play
      await vi.advanceTimersByTimeAsync(300);

      // First playing event fires after loadeddata
      tracker.recordPlaying(45.0);
      await Promise.resolve();

      // Now start sample is emitted!
      expect(sentBatches).toHaveLength(1);
      const start = sentBatches[0].samples[0];
      expect(start.kind).toBe('start');
      expect(start.seq).toBe(0);
      expect(start.startup_ms).toBe(300); // 300ms from play request, NOT 5300ms from page load!
      expect(start.position_ms).toBe(45000);
      expect(start.watched_ms).toBe(0);
      expect(start.rebuffer_ms).toBe(0);
      expect(start.rebuffer_count).toBe(0);

      tracker.destroy();
    });

    it('5. manual quality switch: attributes rendition and bitrate changes, tracks rebuffering if switch stalls, ignores stall if switched while paused', async () => {
      const sentBatches: PlaybackHeartbeatBatch[] = [];
      const mockTransport = vi.fn(async (batch: PlaybackHeartbeatBatch) => {
        sentBatches.push(batch);
        return true;
      });

      const tracker = new PlaybackTracker({
        videoId: defaultVideoId,
        playbackId: defaultPlaybackId,
        transport: mockTransport,
      });

      tracker.setRendition('1080p', 5000);
      tracker.recordPlayRequest();
      tracker.recordLoadedData();
      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(1);
      expect(sentBatches[0].samples[0].rendition).toBe('1080p');
      expect(sentBatches[0].samples[0].bitrate_kbps).toBe(5000);

      // Play 10s at 1080p
      for (let s = 1; s <= 10; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }

      // User manually switches to 720p: player buffers new rendition segments for 500ms
      tracker.setRendition('720p', 2800);
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(500);
      tracker.recordPlaying(10); // resumes at 720p

      // Play remaining 20s of the interval at 720p
      for (let s = 11; s <= 30; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      await Promise.resolve();

      expect(sentBatches).toHaveLength(2);
      const hb1 = sentBatches[1].samples[0];
      expect(hb1.kind).toBe('heartbeat');
      expect(hb1.rendition).toBe('720p');
      expect(hb1.bitrate_kbps).toBe(2800);
      expect(hb1.rebuffer_count).toBe(1);
      expect(hb1.rebuffer_ms).toBe(500);
      expect(hb1.watched_ms).toBe(30000);

      // Now user pauses and manually switches to 480p while paused
      tracker.recordPause();
      tracker.setRendition('480p', 1200);
      // Buffering occurs while paused
      tracker.recordWaiting();
      await vi.advanceTimersByTimeAsync(10000); // 10s paused
      tracker.recordPlayRequest();
      tracker.recordPlaying(30);

      // Play 30s at 480p
      for (let s = 31; s <= 60; s++) {
        tracker.recordTimeUpdate(s);
        await vi.advanceTimersByTimeAsync(1000);
      }
      await Promise.resolve();

      expect(sentBatches).toHaveLength(3);
      const hb2 = sentBatches[2].samples[0];
      expect(hb2.rendition).toBe('480p');
      expect(hb2.bitrate_kbps).toBe(1200);
      // Buffering while paused was NOT counted as rebuffer
      expect(hb2.rebuffer_count).toBe(0);
      expect(hb2.rebuffer_ms).toBe(0);
      // In this 30s period: 10s paused + 20s played = 20000ms watched
      expect(hb2.watched_ms).toBe(20000);

      tracker.destroy();
    });
  });
});
