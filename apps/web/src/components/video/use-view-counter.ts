'use client';

import { useCallback, useEffect, useRef } from 'react';
import { api } from '../../lib/api-client';

export interface UseViewCounterOptions {
  videoId: string;
  durationMs?: number | null;
  onRecordView?: (playbackId: string, watchedMs: number) => Promise<void> | void;
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback UUIDv4 generator
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function calculateThresholdMs(durationMs?: number | null): number {
  if (typeof durationMs === 'number' && durationMs > 0) {
    return Math.min(30000, durationMs / 2);
  }
  return 30000;
}

export function useViewCounter({ videoId, durationMs, onRecordView }: UseViewCounterOptions) {
  const playbackIdRef = useRef<string>(generateUUID());
  const watchedMsRef = useRef<number>(0);
  const hasRecordedRef = useRef<boolean>(false);
  const lastPositionRef = useRef<number | null>(null);
  const isSeekingRef = useRef<boolean>(false);

  // Reset when videoId changes
  useEffect(() => {
    playbackIdRef.current = generateUUID();
    watchedMsRef.current = 0;
    hasRecordedRef.current = false;
    lastPositionRef.current = null;
    isSeekingRef.current = false;
  }, [videoId]);

  const thresholdMs = calculateThresholdMs(durationMs);

  const triggerRecord = useCallback(async () => {
    if (hasRecordedRef.current || !videoId) return;
    hasRecordedRef.current = true;
    const playbackId = playbackIdRef.current;
    const watchedMs = Math.floor(watchedMsRef.current);

    try {
      if (onRecordView) {
        await onRecordView(playbackId, watchedMs);
      } else {
        await api.video.POST('/v1/videos/{video_id}/views', {
          params: { path: { video_id: videoId } },
          body: {
            playback_id: playbackId,
            watched_ms: watchedMs,
          },
        });
      }
    } catch (err) {
      // Swallowed: reporting errors must never disrupt the viewer
      console.debug('[ViewCounter] Failed to record view:', err);
    }
  }, [videoId, onRecordView]);

  const onPlay = useCallback((currentTime: number) => {
    lastPositionRef.current = currentTime;
  }, []);

  const onTimeUpdate = useCallback(
    (currentTime: number) => {
      if (isSeekingRef.current) return;

      if (lastPositionRef.current !== null) {
        const delta = currentTime - lastPositionRef.current;
        // Only count forward progress that is reasonable (0s to 1s) to exclude jumps/seeks
        if (delta > 0 && delta <= 1.0) {
          watchedMsRef.current += delta * 1000;
        }
      }
      lastPositionRef.current = currentTime;

      if (!hasRecordedRef.current && watchedMsRef.current >= thresholdMs) {
        void triggerRecord();
      }
    },
    [thresholdMs, triggerRecord],
  );

  const onSeeking = useCallback(() => {
    isSeekingRef.current = true;
  }, []);

  const onSeeked = useCallback((currentTime: number) => {
    isSeekingRef.current = false;
    lastPositionRef.current = currentTime;
  }, []);

  const onEnded = useCallback(() => {
    if (!hasRecordedRef.current && watchedMsRef.current >= thresholdMs) {
      void triggerRecord();
    }
  }, [thresholdMs, triggerRecord]);

  return {
    playbackIdRef,
    watchedMsRef,
    hasRecordedRef,
    thresholdMs,
    onPlay,
    onTimeUpdate,
    onSeeking,
    onSeeked,
    onEnded,
  };
}
