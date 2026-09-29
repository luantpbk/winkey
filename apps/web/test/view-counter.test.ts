import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  calculateThresholdMs,
  generateUUID,
  useViewCounter,
} from '../src/components/video/use-view-counter';

describe('View Counter Logic (C3)', () => {
  describe('calculateThresholdMs', () => {
    it('returns min(30000, duration_ms / 2) for short videos', () => {
      // 10s video (10000 ms) -> threshold is 5000 ms (5s)
      expect(calculateThresholdMs(10000)).toBe(5000);
      // 40s video (40000 ms) -> threshold is 20000 ms (20s)
      expect(calculateThresholdMs(40000)).toBe(20000);
    });

    it('returns 30000 ms (30s) for videos longer than 60s', () => {
      // 2 minutes video (120000 ms) -> threshold is capped at 30000 ms (30s)
      expect(calculateThresholdMs(120000)).toBe(30000);
      // 1 hour video
      expect(calculateThresholdMs(3600000)).toBe(30000);
    });

    it('defaults to 30000 ms if duration is null or undefined', () => {
      expect(calculateThresholdMs(null)).toBe(30000);
      expect(calculateThresholdMs(undefined)).toBe(30000);
      expect(calculateThresholdMs(0)).toBe(30000);
    });
  });

  describe('generateUUID', () => {
    it('generates a valid UUID string format', () => {
      const uuid = generateUUID();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe('useViewCounter hook behavior', () => {
    it('accumulates watched_ms during normal linear playback and calls onRecordView once', async () => {
      const onRecordView = vi.fn().mockResolvedValue(undefined);
      const videoId = 'test-video-1';
      // 10s duration -> threshold is 5s (5000 ms)
      const durationMs = 10000;

      const { result } = renderHook(() => useViewCounter({ videoId, durationMs, onRecordView }));

      expect(result.current.thresholdMs).toBe(5000);
      expect(result.current.hasRecordedRef.current).toBe(false);

      // Start playback at 0
      act(() => {
        result.current.onPlay(0);
      });

      // Advance playback smoothly by 0.5s intervals (10 intervals = 5s)
      for (let sec = 0.5; sec <= 5.0; sec += 0.5) {
        act(() => {
          result.current.onTimeUpdate(sec);
        });
      }

      // Threshold (5000ms) reached
      expect(onRecordView).toHaveBeenCalledTimes(1);
      const [calledPlaybackId, calledWatchedMs] = onRecordView.mock.calls[0];
      expect(calledPlaybackId).toBe(result.current.playbackIdRef.current);
      expect(calledWatchedMs).toBeGreaterThanOrEqual(5000);
      expect(result.current.hasRecordedRef.current).toBe(true);

      // Further playback continues, but onRecordView must NOT be called again
      for (let sec = 5.5; sec <= 8.0; sec += 0.5) {
        act(() => {
          result.current.onTimeUpdate(sec);
        });
      }
      expect(onRecordView).toHaveBeenCalledTimes(1);
    });

    it('excludes seeking/skipping from watched_ms', () => {
      const onRecordView = vi.fn().mockResolvedValue(undefined);
      const videoId = 'test-video-seeking';
      // 60s video -> threshold is 30s (30000 ms)
      const durationMs = 60000;

      const { result } = renderHook(() => useViewCounter({ videoId, durationMs, onRecordView }));

      // Play from 0 to 2s
      act(() => {
        result.current.onPlay(0);
        result.current.onTimeUpdate(1.0);
        result.current.onTimeUpdate(2.0);
      });
      // Accumulated ~2000 ms
      expect(result.current.watchedMsRef.current).toBe(2000);

      // User seeks to 50s (jump of 48s!)
      act(() => {
        result.current.onSeeking();
        result.current.onSeeked(50.0);
      });

      // After seeked, watchedMs must STILL be ~2000 ms (NOT 50000 ms)
      expect(result.current.watchedMsRef.current).toBe(2000);
      expect(onRecordView).not.toHaveBeenCalled();

      // Play from 50s to 52s (another 2s)
      act(() => {
        result.current.onTimeUpdate(51.0);
        result.current.onTimeUpdate(52.0);
      });

      expect(result.current.watchedMsRef.current).toBe(4000);
      expect(onRecordView).not.toHaveBeenCalled();
    });

    it('swallows errors if onRecordView rejects without crashing the player', async () => {
      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const onRecordView = vi.fn().mockRejectedValue(new Error('Network error (500)'));
      const videoId = 'test-video-err';
      const durationMs = 4000; // threshold = 2000 ms

      const { result } = renderHook(() => useViewCounter({ videoId, durationMs, onRecordView }));

      act(() => {
        result.current.onPlay(0);
        result.current.onTimeUpdate(1.0);
        result.current.onTimeUpdate(2.0);
      });

      // Does not throw
      expect(onRecordView).toHaveBeenCalledTimes(1);
      expect(result.current.hasRecordedRef.current).toBe(true);

      consoleDebugSpy.mockRestore();
    });
  });
});
