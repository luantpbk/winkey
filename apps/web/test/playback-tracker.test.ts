import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackTracker } from '../src/lib/video/playback-tracker';
import type { PlaybackHeartbeatBatch } from '@winkey/api-client';

describe('PlaybackTracker Unit Tests (R1 telemetry & QoE)', () => {
  const defaultVideoId = '0192f5e4-7c1a-7b3e-9d2a-test-video';
  const defaultPlaybackId = '0192f5e4-7c1a-7b3e-9d2a-test-playback';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      tracker.recordPlaying(0);
      await Promise.resolve();

      const startSample = sentBatches[0].samples[0];
      expect(startSample.rendition).toBe('1080p');
      expect(startSample.bitrate_kbps).toBe(5000);

      // Switch to 720p
      tracker.setRendition('720p', 2800);
      await vi.advanceTimersByTimeAsync(30000);
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

  describe('Stall and Rebuffering Tracking', () => {
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
  });

  describe('Lifecycle: End, Errors, and Page Hide', () => {
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

    it('flushes synchronously on visibilitychange to hidden', async () => {
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

      tracker.recordPlaying(0);
      await Promise.resolve();
      for (let s = 1; s <= 14; s++) {
        tracker.recordTimeUpdate(s);
      }

      // Mock document.visibilityState
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
        writable: true,
      });

      document.dispatchEvent(new Event('visibilitychange'));

      expect(syncCalls).toHaveLength(1);
      const end = syncCalls[0].samples[0];
      expect(end.kind).toBe('end');
      expect(end.position_ms).toBe(14000);

      tracker.destroy();
    });
  });

  describe('Batching Limits, Retry Policy, and 429 Back-off', () => {
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

      tracker.recordPlaying(0);
      await Promise.resolve();
      expect(sentBatches).toHaveLength(1); // start sample

      // Queue 20 additional heartbeat samples by advancing time
      // 20 * 30s = 600s
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(30000);
        await Promise.resolve();
      }

      // Should have sent all 20
      expect(sentBatches.length).toBeGreaterThanOrEqual(2);
      expect(tracker.getQueueLength()).toBe(0);

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

      tracker.recordPlaying(0);
      await Promise.resolve();

      // Call 1 fails -> batch is retained for retry
      expect(callCount).toBe(1);
      expect(tracker.getQueueLength()).toBe(1);

      // Trigger second flush via heartbeat
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

      tracker.recordPlaying(0);
      await Promise.resolve();

      expect(callCount).toBe(1);
      expect(tracker.getQueueLength()).toBe(0); // dropped!
      expect(tracker.isBackoff()).toBe(true);

      // Attempt to flush during back-off (at 30s) -> should be skipped!
      await vi.advanceTimersByTimeAsync(30000);
      await Promise.resolve();
      expect(callCount).toBe(1);
      expect(tracker.isBackoff()).toBe(true);

      // After 60s (at 60s+), back-off is cleared, heartbeat fires and succeeds
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
});
